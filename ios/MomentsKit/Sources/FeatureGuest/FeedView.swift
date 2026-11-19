import CoreGraphics
import DesignSystem
import MomentsDomain
import SwiftUI

/// The joined guest's feed: a three-column grid, newest first.
public struct FeedView: View {
    let model: FeedModel
    let thumbnails: ThumbnailLoader
    let viewerImages: ThumbnailLoader
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
    @State private var viewing: ViewerRequest?
    #endif

    private static let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 3)
    private static let topID = "feed-top"

    public init(model: FeedModel, thumbnails: ThumbnailLoader, viewerImages: ThumbnailLoader) {
        self.model = model
        self.thumbnails = thumbnails
        self.viewerImages = viewerImages
    }

    public var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    Text(verbatim: model.event.title)
                        .font(MomentsFont.display(.title))
                        .foregroundStyle(MomentsColor.text)
                        .accessibilityAddTraits(.isHeader)
                        .padding(.horizontal, Spacing.md)
                        .id(Self.topID)
                    content
                }
                .padding(.vertical, Spacing.md)
            }
            .refreshable { await model.refresh() }
            .overlay(alignment: .top) {
                if model.newMomentCount > 0 {
                    newMomentsPill { proxy.scrollTo(Self.topID, anchor: .top) }
                        .padding(.top, Spacing.sm)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .momentsAnimation(value: model.newMomentCount > 0)
        }
        .onChange(of: model.newMomentCount) { old, new in
            guard new > old else { return }
            // Through AttributedString so the inflection applies; String(localized:)
            // would read out the raw "^[…](inflect: true)" markup.
            let message = AttributedString(localized: "^[\(new) new moment](inflect: true)")
            AccessibilityNotification.Announcement(String(message.characters)).post()
        }
        // Back from the background: don't wait for the next 15 s tick.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.poll() } }
        }
        .background(MomentsColor.background)
        .task {
            await model.loadFirstPage()
            await model.pollUntilCancelled()
        }
        #if os(iOS)
        .fullScreenCover(item: $viewing) { request in
            MomentViewer(model: model, images: viewerImages, start: request.id)
                .presentationBackground(.clear)
        }
        #endif
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView()
                .tint(MomentsColor.textMuted)
                .frame(maxWidth: .infinity, minHeight: 200)
                .accessibilityLabel(Text("Loading moments"))
        case .failed(.temporary):
            message("Can't reach Moments", detail: "Check your connection and try again.")
            Button("Try again") { Task { await model.loadFirstPage() } }
                .buttonStyle(.momentsPrimary)
                .padding(.horizontal, Spacing.md)
        case .failed(.eventGone):
            message("This event has ended", detail: "Its moments are no longer available.")
        case .accessLost:
            message("Access changed", detail: "The host changed this event's access. Join again to keep watching.")
        case .guestRequired:
            message("You're no longer in this event", detail: "Join again to keep watching and sharing.")
        case .loaded where model.moments.isEmpty:
            message("No moments yet", detail: "Photos and videos shared by guests will appear here.")
        case .loaded:
            grid
        }
    }

    private var grid: some View {
        VStack(spacing: Spacing.md) {
            if model.refreshFailed {
                Text("Couldn't refresh. Check your connection.")
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.accent)
                    .padding(.horizontal, Spacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            LazyVGrid(columns: Self.columns, spacing: 2) {
                ForEach(model.moments) { moment in
                    Button { open(moment) } label: {
                        MomentThumbnail(moment: moment, thumbnails: thumbnails)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(Text("Opens it full screen"))
                    .onAppear { model.loadOlderIfNeeded(near: moment) }
                }
            }
            if model.isLoadingOlder {
                ProgressView().tint(MomentsColor.textMuted)
            } else if model.olderPageFailed {
                Button("Couldn't load more. Try again") { model.retryOlder() }
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.accent)
                    .frame(minHeight: Radius.minimumTapTarget)
            }
        }
    }

    private func open(_ moment: Moment) {
        #if os(iOS)
        viewing = ViewerRequest(id: moment.id)
        #endif
    }

    private func newMomentsPill(scrollToTop: @escaping () -> Void) -> some View {
        Button {
            model.revealNewMoments()
            scrollToTop()
        } label: {
            Label {
                Text("^[\(model.newMomentCount) new moment](inflect: true)")
            } icon: {
                Image(systemName: "arrow.up")
            }
            .font(MomentsFont.body(.subheadline).bold())
            .foregroundStyle(MomentsColor.onAccent)
            .padding(.horizontal, Spacing.md)
            .frame(minHeight: Radius.minimumTapTarget)
            .background(MomentsColor.accent, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text("Shows them at the top of the feed"))
    }

    private func message(_ title: LocalizedStringKey, detail: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(title)
                .font(MomentsFont.heading())
                .foregroundStyle(MomentsColor.text)
            Text(detail)
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
        }
        .padding(.horizontal, Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One square cell. Videos show their poster with a play badge.
struct MomentThumbnail: View {
    let moment: Moment
    let thumbnails: ThumbnailLoader
    @State private var image: CGImage?
    @State private var failed = false
    @State private var attempt = 0

    /// About a third of the widest phone at 3x.
    private static let pixelSize = 440

    var body: some View {
        Rectangle()
            .fill(MomentsColor.surface)
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if let image {
                    Image(decorative: image, scale: 1)
                        .resizable()
                        .scaledToFill()
                } else if failed {
                    Image(systemName: "photo")
                        .foregroundStyle(MomentsColor.textMuted)
                }
            }
            .overlay(alignment: .topTrailing) {
                if moment.media.kind == .video {
                    Image(systemName: "play.fill")
                        .font(.caption)
                        .foregroundStyle(MomentsColor.text)
                        .padding(Spacing.xxs)
                        .background(MomentsColor.background.opacity(0.6), in: Circle())
                        .padding(Spacing.xxs)
                }
            }
            .overlay(alignment: .bottomLeading) {
                if moment.reactionCount > 0 {
                    HStack(spacing: 2) {
                        Image(systemName: moment.hasReacted ? "heart.fill" : "heart")
                            .foregroundStyle(moment.hasReacted ? MomentsColor.accent : MomentsColor.text)
                        Text(verbatim: "\(moment.reactionCount)")
                            .foregroundStyle(MomentsColor.text)
                    }
                    .font(MomentsFont.number(.caption2))
                    .padding(.horizontal, Spacing.xxs)
                    .padding(.vertical, 2)
                    .background(MomentsColor.background.opacity(0.6), in: Capsule())
                    .padding(Spacing.xxs)
                }
            }
            .clipped()
            .contentShape(Rectangle())
            // Scrolling a failed thumbnail back into view retries it.
            .onAppear { if failed { attempt += 1 } }
            .accessibilityElement()
            .accessibilityLabel(accessibilityLabel)
            .accessibilityAddTraits(.isImage)
            // Same view either way (a conditional modifier would reset the cell's state).
            .accessibilityValue(heartsValue)
            .task(id: LoadKey(url: thumbnailURL, attempt: attempt)) { await load() }
    }

    /// Smallest rendition that fills the cell; videos never use the video file.
    private var thumbnailURL: URL? {
        let media = moment.media
        let candidate = media.kind == .video
            ? media.thumbURL ?? media.posterURL
            : media.thumbURL ?? media.displayURL ?? media.url
        return candidate.flatMap(URL.init(string:))
    }

    private struct LoadKey: Equatable {
        let url: URL?
        let attempt: Int
    }

    /// Whole sentences, so each language can order the parts its own way.
    private var accessibilityLabel: Text {
        let name = moment.uploaderName
        let caption = moment.caption.flatMap { $0.isEmpty ? nil : $0 }
        switch (moment.media.kind == .video, caption) {
        case (true, nil): return Text("Video by \(name)")
        case (false, nil): return Text("Photo by \(name)")
        case let (true, caption?): return Text("Video by \(name): \(caption)")
        case let (false, caption?): return Text("Photo by \(name): \(caption)")
        }
    }

    private var heartsValue: Text {
        let count = moment.reactionCount
        if moment.hasReacted { return Text("^[\(count) heart](inflect: true), including yours") }
        return count > 0 ? Text("^[\(count) heart](inflect: true)") : Text(verbatim: "")
    }

    private func load() async {
        guard let thumbnailURL else { return failed = true }
        do {
            image = try await thumbnails.image(at: thumbnailURL, maxPixelSize: Self.pixelSize)
            failed = false
        } catch is CancellationError {
            return
        } catch {
            failed = true
        }
    }
}
