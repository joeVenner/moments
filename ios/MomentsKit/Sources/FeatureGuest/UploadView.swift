import DesignSystem
import MediaPipeline
import PhotosUI
import SwiftUI

/// Pick photos and videos, add a caption, and share them to the event.
/// The picker runs outside the app, so no photo-library permission is asked.
public struct UploadView: View {
    @Bindable var model: UploadModel
    @State private var selection: [PhotosPickerItem] = []
    @State private var sharedCount = 0
    @Environment(\.dismiss) private var dismiss

    public init(model: UploadModel) {
        self.model = model
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
                        if model.isSharing { ProgressView().tint(MomentsColor.onAccent) } else { Text(shareTitle) }
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
                }
            }
        }
        .haptic(.uploadComplete, trigger: sharedCount)
        .onChange(of: selection) { _, picked in
            guard !picked.isEmpty else { return }
            model.add(picked.map { item in { try await item.loadTransferable(type: PickedMedia.self) } })
            selection = []
        }
    }

    private var picker: some View {
        PhotosPicker(
            selection: $selection,
            maxSelectionCount: max(1, UploadModel.maxPicks - model.items.count),
            selectionBehavior: .ordered,
            matching: .any(of: [.images, .videos]),
            preferredItemEncoding: .compatible
        ) {
            Label(model.items.isEmpty ? "Choose photos and videos" : "Add more", systemImage: "photo.on.rectangle.angled")
                .font(MomentsFont.body(.headline))
                .foregroundStyle(MomentsColor.text)
                .frame(maxWidth: .infinity, minHeight: Radius.minimumTapTarget)
                .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).stroke(MomentsColor.border))
        }
        .disabled(model.items.count >= UploadModel.maxPicks || model.isSharing)
    }

    private var grid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: Spacing.xs)], spacing: Spacing.xs) {
            ForEach(model.items) { item in
                UploadTile(item: item, retry: { model.retry(item.id) }, remove: { model.remove(item.id) })
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
            if model.isCaptionTooLong {
                Text("Captions can be up to \(UploadModel.maxCaptionLength) characters.")
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
                sharedCount += 1
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

/// One pick: its state, and what can be done with it.
private struct UploadTile: View {
    let item: UploadModel.Item
    let retry: () -> Void
    let remove: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(spacing: Spacing.xxs) {
                content
            }
            .frame(maxWidth: .infinity, minHeight: 100)
            .padding(Spacing.xs)
            .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).stroke(MomentsColor.border))
            if item.state != .shared {
                Button(action: remove) {
                    Image(systemName: "xmark.circle.fill")
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(MomentsColor.text, MomentsColor.border)
                        .frame(width: Radius.minimumTapTarget, height: Radius.minimumTapTarget)
                }
                .accessibilityLabel(Text("Remove"))
            }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var content: some View {
        let icon = item.kind == .video ? "video" : "photo"
        switch item.state {
        case .preparing:
            ProgressView().tint(MomentsColor.textMuted)
            Text("Preparing…").font(MomentsFont.body(.caption)).foregroundStyle(MomentsColor.textMuted)
        case let .ready(media):
            Image(systemName: icon).font(.title2).foregroundStyle(MomentsColor.text)
            Text(media.duration.map { Duration.seconds($0).formatted(.time(pattern: .minuteSecond)) } ?? "Ready")
                .font(MomentsFont.body(.caption)).foregroundStyle(MomentsColor.textMuted)
        case let .failed(problem):
            Image(systemName: "exclamationmark.triangle").font(.title2).foregroundStyle(MomentsColor.accent)
            Text(message(problem)).font(MomentsFont.body(.caption)).foregroundStyle(MomentsColor.text)
                .multilineTextAlignment(.center)
            if item.canRetry {
                Button("Try again", action: retry).font(MomentsFont.body(.caption).bold()).tint(MomentsColor.accent)
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
