import DesignSystem
import MediaPipeline
import PhotosUI
import SwiftUI

/// Pick photos and videos, add a caption, and share them to the event.
/// The picker runs outside the app, so no photo-library permission is asked.
public struct UploadView: View {
    @Bindable var model: UploadModel
    /// Called after a batch is queued (the sheet closes right after).
    let onShared: () -> Void
    @State private var selection: [PhotosPickerItem] = []
    @ScaledMetric private var tileSize: CGFloat = 100
    @Environment(\.dismiss) private var dismiss

    public init(model: UploadModel, onShared: @escaping () -> Void = {}) {
        self.model = model
        self.onShared = onShared
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    picker
                    if !model.items.isEmpty { grid }
                    if model.hasVideo {
                        Label("Videos are shared with their sound.", systemImage: "speaker.wave.2")
                            .font(MomentsFont.body(.footnote))
                            .foregroundStyle(MomentsColor.textMuted)
                    }
                    captionField
                    if let problem = model.shareProblem {
                        Text(shareMessage(problem))
                            .font(MomentsFont.body(.footnote))
                            .foregroundStyle(MomentsColor.text)
                    }
                    Button(action: share) {
                        if model.isSharing {
                            ProgressView().tint(MomentsColor.onAccent).accessibilityLabel(Text("Sharing"))
                        } else {
                            Text(shareTitle)
                        }
                    }
                    .buttonStyle(.momentsPrimary)
                    .disabled(!model.canShare)
                }
                .padding(Spacing.lg)
                .frame(maxWidth: 560, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(MomentsColor.background)
            .navigationTitle("Share moments")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        model.discardAll()
                        dismiss()
                    }
                    .disabled(model.isSharing)
                }
            }
        }
        // Closing mid-share would drop files the queue is taking.
        .interactiveDismissDisabled(model.isSharing)
        .onChange(of: selection) { _, picked in
            guard !picked.isEmpty else { return }
            model.add(picked.map { item in { try await item.loadTransferable(type: PickedMedia.self) } })
            selection = []
        }
    }

    private var picker: some View {
        PhotosPicker(
            selection: $selection,
            maxSelectionCount: max(1, model.remainingSlots),
            selectionBehavior: .ordered,
            matching: .any(of: [.images, .videos]),
            // The originals: our own preparing converts them once (the
            // system's compatible transcode would add a second pass).
            preferredItemEncoding: .current
        ) {
            Label(model.items.isEmpty ? "Choose photos and videos" : "Add more", systemImage: "photo.on.rectangle.angled")
                .font(MomentsFont.body(.headline))
                .foregroundStyle(MomentsColor.text)
                .frame(maxWidth: .infinity, minHeight: Radius.minimumTapTarget)
                .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).stroke(MomentsColor.border))
        }
        .disabled(model.remainingSlots == 0 || model.isSharing)
    }

    private var grid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: tileSize), spacing: Spacing.xs)], spacing: Spacing.xs) {
            ForEach(Array(model.items.enumerated()), id: \.element.id) { index, item in
                UploadTile(
                    item: item, position: index + 1, size: tileSize, canRemove: !model.isSharing,
                    retry: { model.retry(item.id) }, remove: { model.remove(item.id) }
                )
            }
        }
    }

    private var captionField: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            TextField(text: $model.caption, prompt: Text("Add a caption (optional)").foregroundStyle(MomentsColor.textMuted), axis: .vertical) {
                Text("Caption")
            }
            .lineLimit(1 ... 4)
            .padding(.vertical, Spacing.xs)
            .momentsField()
            .disabled(model.isSharing)
            if model.isCaptionTooLong {
                Text("Captions can be up to \(UploadModel.maxCaptionLength) characters.")
                    .font(MomentsFont.body(.footnote))
                    .foregroundStyle(MomentsColor.text)
            } else if model.captionHasInvalidCharacters {
                Text("Captions can't contain tabs or other special characters.")
                    .font(MomentsFont.body(.footnote))
                    .foregroundStyle(MomentsColor.text)
            }
        }
    }

    private var shareTitle: LocalizedStringKey {
        model.readyCount > 0 ? "Share ^[\(model.readyCount) moment](inflect: true)" : "Share"
    }

    private func share() {
        Task {
            await model.share()
            if model.shareProblem == nil, !model.items.contains(where: { $0.state != .shared }) {
                onShared()
                dismiss()
            }
        }
    }

    private func shareMessage(_ problem: UploadModel.ShareProblem) -> LocalizedStringKey {
        switch problem {
        case .queueFull: "Too many moments are waiting to upload. Try again once some have finished."
        case .failed: "Couldn't add these to your uploads. Try again."
        }
    }
}

/// One pick: its state, and what can be done with it. VoiceOver reads it
/// as one element with Remove and Try again as actions.
private struct UploadTile: View {
    let item: UploadModel.Item
    let position: Int
    let size: CGFloat
    let canRemove: Bool
    let retry: () -> Void
    let remove: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(spacing: Spacing.xxs) {
                content
            }
            .frame(maxWidth: .infinity, minHeight: size)
            .padding(Spacing.xs)
            .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).stroke(MomentsColor.border))
            if item.state != .shared, canRemove {
                Button(action: remove) {
                    Image(systemName: "xmark.circle.fill")
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(MomentsColor.text, MomentsColor.border)
                        .frame(width: Radius.minimumTapTarget, height: Radius.minimumTapTarget)
                }
                .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(accessibilityName) + Text(verbatim: ", ") + Text(statusText))
        .accessibilityActions {
            if item.state != .shared, canRemove { Button("Remove", action: remove) }
            if item.canRetry { Button("Try again", action: retry) }
        }
    }

    private var accessibilityName: LocalizedStringKey {
        switch item.kind {
        case .video: "Video \(position)"
        case .photo: "Photo \(position)"
        case nil: "Item \(position)"
        }
    }

    private var statusText: LocalizedStringKey {
        switch item.state {
        case .preparing: "Preparing…"
        case let .ready(media):
            if let duration = media.duration {
                "Ready, \(Duration.seconds(duration).formatted(.time(pattern: .minuteSecond)))"
            } else {
                "Ready"
            }
        case let .failed(problem): message(problem)
        case .shared: "Added"
        }
    }

    @ViewBuilder private var content: some View {
        let icon = item.kind == .video ? "video" : "photo"
        switch item.state {
        case .preparing:
            ProgressView().tint(MomentsColor.textMuted)
            Text(statusText).font(MomentsFont.body(.caption)).foregroundStyle(MomentsColor.textMuted)
        case let .ready(media):
            Image(systemName: icon).font(.title2).foregroundStyle(MomentsColor.text)
            if let duration = media.duration {
                Text(verbatim: Duration.seconds(duration).formatted(.time(pattern: .minuteSecond)))
                    .font(MomentsFont.body(.caption)).foregroundStyle(MomentsColor.textMuted)
            } else {
                Text("Ready").font(MomentsFont.body(.caption)).foregroundStyle(MomentsColor.textMuted)
            }
        case let .failed(problem):
            Image(systemName: "exclamationmark.triangle").font(.title2).foregroundStyle(MomentsColor.accent)
            Text(message(problem)).font(MomentsFont.body(.caption)).foregroundStyle(MomentsColor.text)
                .multilineTextAlignment(.center)
            if item.canRetry {
                Button("Try again", action: retry)
                    .font(MomentsFont.body(.caption).bold())
                    .tint(MomentsColor.accent)
                    .frame(minHeight: Radius.minimumTapTarget)
            }
        case .shared:
            Image(systemName: "checkmark.circle").font(.title2).foregroundStyle(MomentsColor.accent)
            Text("Added").font(MomentsFont.body(.caption)).foregroundStyle(MomentsColor.textMuted)
        }
    }

    private func message(_ problem: MediaImporter.Problem) -> LocalizedStringKey {
        switch problem {
        case .unsupported: "This file can't be shared."
        case .tooLarge: item.kind == .video ? "Too long or too large (up to 10 minutes)." : "This photo is too large."
        case .failed: "Couldn't prepare this. Keep the app open while it prepares."
        case .cancelled: "Stopped."
        case .noSpace: "Your phone is out of storage."
        case .busy: "Still preparing."
        }
    }
}
