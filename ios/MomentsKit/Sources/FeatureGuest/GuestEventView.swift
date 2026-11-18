import DesignSystem
import MomentsAPI
import MomentsDomain
import SwiftUI

/// One event for a guest: the join flow, then the feed once joined.
public struct GuestEventView: View {
    let join: JoinModel
    let dependencies: GuestDependencies
    /// Called when the feed loses access, to start a fresh join flow.
    let rejoin: () -> Void
    @State private var feed: FeedModel?
    @State private var thumbnails: ThumbnailLoader?
    @State private var viewerImages: ThumbnailLoader?

    public init(join: JoinModel, dependencies: GuestDependencies, rejoin: @escaping () -> Void) {
        self.join = join
        self.dependencies = dependencies
        self.rejoin = rejoin
    }

    public var body: some View {
        Group {
            if let feed, let thumbnails, let viewerImages {
                VStack(spacing: 0) {
                    if join.hasUnsavedIdentity { unsavedBanner }
                    FeedView(model: feed, thumbnails: thumbnails, viewerImages: viewerImages)
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
        // Lost access: drop cached images of the private event.
        .onChange(of: feed?.phase) { _, phase in
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
