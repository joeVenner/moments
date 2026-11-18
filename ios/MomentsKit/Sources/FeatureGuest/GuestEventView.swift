import DesignSystem
import MomentsAPI
import MomentsDomain
import SwiftUI

/// One event for a guest: the join flow, then the feed, highlights and
/// leaderboard as tabs once joined.
public struct GuestEventView: View {
    let join: JoinModel
    let dependencies: GuestDependencies
    /// Called when the feed loses access, to start a fresh join flow.
    let rejoin: () -> Void
    @State private var feed: FeedModel?
    @State private var highlights: HighlightsModel?
    @State private var leaderboard: LeaderboardModel?
    @State private var thumbnails: ThumbnailLoader?
    @State private var viewerImages: ThumbnailLoader?

    public init(join: JoinModel, dependencies: GuestDependencies, rejoin: @escaping () -> Void) {
        self.join = join
        self.dependencies = dependencies
        self.rejoin = rejoin
    }

    public var body: some View {
        Group {
            if let feed, let highlights, let leaderboard, let thumbnails, let viewerImages {
                VStack(spacing: 0) {
                    if join.hasUnsavedIdentity { unsavedBanner }
                    TabView {
                        FeedView(model: feed, thumbnails: thumbnails, viewerImages: viewerImages)
                            .tabItem { Label("Moments", systemImage: "square.grid.3x3") }
                        HighlightsView(model: highlights, thumbnails: thumbnails, viewerImages: viewerImages)
                            .tabItem { Label("Highlights", systemImage: "heart") }
                        LeaderboardView(model: leaderboard)
                            .tabItem { Label("Leaderboard", systemImage: "trophy") }
                    }
                    .tint(MomentsColor.accent)
                    if feed.phase == .accessLost {
                        Button("Join again", action: rejoin)
                            .buttonStyle(.momentsPrimary)
                            .padding(Spacing.md)
                    }
                }
                .background(MomentsColor.background)
            } else {
                JoinView(model: join)
            }
        }
        // The event ended for this guest: every tab stops; lost access also
        // drops cached images of the private event.
        .onChange(of: feed?.phase) { _, phase in
            guard phase == .accessLost || phase == .failed(.eventGone) else { return }
            highlights?.end()
            leaderboard?.end()
            guard phase == .accessLost else { return }
            for loader in [thumbnails, viewerImages].compactMap(\.self) { Task { await loader.removeAll() } }
        }
        .onChange(of: join.phase, initial: true) { _, phase in
            guard case let .joined(event, participant) = phase, feed == nil else { return }
            let feedModel = FeedModel(
                event: event, participant: participant, slug: join.slug, reactorID: dependencies.reactorID(event.id),
                service: dependencies.service, store: dependencies.store
            )
            thumbnails = ThumbnailLoader(fetcher: dependencies.mediaFetcher, accessGrant: feedModel.mediaAccessGrant)
            // Full-screen images may be originals: a larger download cap, but
            // only two at a time (up to 40 MB each in memory).
            viewerImages = ThumbnailLoader(
                fetcher: dependencies.mediaFetcher, accessGrant: feedModel.mediaAccessGrant,
                maxBytes: MediaFetcher.maxBytes, maxConcurrentLoads: 2
            )
            let highlightsModel = HighlightsModel(
                slug: join.slug, reactorID: dependencies.reactorID(event.id),
                service: dependencies.service, store: dependencies.store
            )
            let leaderboardModel = LeaderboardModel(
                slug: join.slug, participantID: participant.id, service: dependencies.service, store: dependencies.store
            )
            // Hearts settled in one list show in the other; errors that end
            // the event are the feed's to show.
            feedModel.onReactionSettled = { [weak highlightsModel] id, state in
                highlightsModel?.applyServerReaction(momentID: id, state: state)
            }
            highlightsModel.onReactionSettled = { [weak feedModel] id, state in
                feedModel?.applyServerReaction(momentID: id, state: state)
            }
            highlightsModel.onFatalError = { [weak feedModel] error in feedModel?.endIfFatal(error) }
            leaderboardModel.onFatalError = { [weak feedModel] error in feedModel?.endIfFatal(error) }
            highlights = highlightsModel
            leaderboard = leaderboardModel
            feed = feedModel
        }
    }

    private var unsavedBanner: some View {
        HStack(spacing: Spacing.sm) {
            Text("Couldn't save your name on this device.")
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.text)
            Spacer()
            Button("Try again") { join.retrySaving() }
                .font(MomentsFont.caption().bold())
                .foregroundStyle(MomentsColor.accent)
                .frame(minHeight: Radius.minimumTapTarget)
        }
        .padding(.horizontal, Spacing.md)
        .background(MomentsColor.surface)
    }
}
