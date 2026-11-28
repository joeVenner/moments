import CoreGraphics
import DesignSystem
import ImageIO
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
        VStack(spacing: 0) {
            SheetHeader(title: "Share moments") {
                Button("Cancel") {
                    model.discardAll()
                    dismiss()
                }
                .disabled(model.isSharing)
            }
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
        }
        .background(MomentsColor.background.ignoresSafeArea())
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
                    item: item, preview: model.previewURL(for: item), position: index + 1, size: tileSize,
                    canRemove: !model.isSharing,
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
    /// The pick's small image on disk, once prepared.
    let preview: URL?
    let position: Int
    let size: CGFloat
    let canRemove: Bool
    let retry: () -> Void
    let remove: () -> Void

    @State private var image: CGImage?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(spacing: Spacing.xxs) {
                if image == nil { content }
            }
            .frame(maxWidth: .infinity, minHeight: size)
            .padding(Spacing.xs)
            .background {
                if let image {
                    Color.clear.overlay {
                        Image(decorative: image, scale: 1).resizable().scaledToFill()
                    }
                    .overlay(alignment: .bottomLeading) { previewBadge }
                } else {
                    MomentsColor.surface
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).stroke(MomentsColor.border))
            .task(id: preview) { image = await Self.loadPreview(preview) }
            if item.state != .shared, canRemove {
                Button(action: remove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(MomentsColor.text)
                        .frame(width: 22, height: 22)
                        .background(MomentsColor.background.opacity(0.7), in: Circle())
                        .frame(width: Radius.minimumTapTarget, height: Radius.minimumTapTarget, alignment: .topTrailing)
                        .padding(Spacing.xxs)
                        .contentShape(Rectangle())
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

    /// On a preview: the video's length, as in the feed.
    @ViewBuilder private var previewBadge: some View {
        if case let .ready(media) = item.state, let duration = media.duration {
            HStack(spacing: 2) {
                Image(systemName: "play.fill")
                Text(verbatim: Duration.seconds(duration).formatted(.time(pattern: .minuteSecond)))
            }
            .font(MomentsFont.number(.caption2))
            .foregroundStyle(MomentsColor.text)
            .padding(.horizontal, Spacing.xxs)
            .padding(.vertical, 2)
            .background(MomentsColor.background.opacity(0.6), in: Capsule())
            .padding(Spacing.xxs)
        }
    }

    /// Decoded off the main actor, straight to tile size.
    private static func loadPreview(_ url: URL?) async -> CGImage? {
        guard let url else { return nil }
        return await Task.detached(priority: .utility) {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil as CGImage? }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 400,
            ]
            return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        }.value
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

/// A sheet's own title row: the title centred between plain text buttons.
/// Used instead of a navigation bar, whose buttons the system draws on a
/// glass capsule.
struct SheetHeader<Leading: View, Trailing: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder let leading: Leading
    @ViewBuilder let trailing: Trailing

    init(title: LocalizedStringKey, @ViewBuilder leading: () -> Leading, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.leading = leading()
        self.trailing = trailing()
    }

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                // Large text: the title gets its own line under the buttons.
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    buttons
                    titleText
                }
            } else {
                ZStack {
                    titleText
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .padding(.horizontal, 96)
                    buttons
                }
            }
        }
        .frame(minHeight: Radius.minimumTapTarget)
        .padding(.horizontal, Spacing.md)
        .padding(.top, Spacing.sm)
        .padding(.bottom, Spacing.xs)
    }

    private var titleText: some View {
        Text(title)
            .font(MomentsFont.heading(.headline))
            .foregroundStyle(MomentsColor.text)
            .accessibilityAddTraits(.isHeader)
    }

    private var buttons: some View {
        HStack {
            leading
            Spacer(minLength: Spacing.sm)
            trailing
        }
        .font(MomentsFont.body())
        .foregroundStyle(MomentsColor.accent)
        .buttonStyle(SheetHeaderButtonStyle())
    }
}

/// A text button in a sheet's title row, with the full 44 pt tap target.
private struct SheetHeaderButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(minWidth: Radius.minimumTapTarget, minHeight: Radius.minimumTapTarget)
            .contentShape(Rectangle())
            .opacity(isEnabled ? (configuration.isPressed ? 0.6 : 1) : 0.5)
    }
}

extension SheetHeader where Trailing == EmptyView {
    init(title: LocalizedStringKey, @ViewBuilder leading: () -> Leading) {
        self.init(title: title, leading: leading, trailing: { EmptyView() })
    }
}
