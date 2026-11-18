import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Observation
import OSLog

/// The event's most-hearted moments, with the same optimistic hearts as the
/// feed. Errors that end the event go to `onFatalError` (the feed owns that
/// state); anything else keeps what is shown.
@MainActor @Observable
public final class HighlightsModel {
    public static let limit = 30

    public private(set) var phase: EventReadPhase = .loading
    public private(set) var isRefreshing = false
    public private(set) var moments: [Moment] = []
    /// Bumped when a reaction is refused and rolled back (for an error haptic).
    public private(set) var reactionFailureCount = 0

    /// Called when the server confirms a heart, so the feed can follow.
    @ObservationIgnored public var onReactionSettled: (@MainActor (_ momentID: String, _ state: ReactionState) -> Void)?
    /// Access lost or event deleted: hand it to the feed.
    @ObservationIgnored public var onFatalError: (@MainActor (any Error) -> Void)?

    @ObservationIgnored private var state = HighlightsState()
    @ObservationIgnored private var throttle = ReloadThrottle()
    @ObservationIgnored private var isLoading = false
    /// Stops loading and hearting once the event has ended for this guest.
    @ObservationIgnored private var hasEnded = false
    @ObservationIgnored private lazy var reactionSenders = ReactionSenders(host: self)
    @ObservationIgnored private let service: any MomentsService
    @ObservationIgnored private let store: any EventCredentialStore
    @ObservationIgnored private let slug: EventSlug
    @ObservationIgnored private let reactorID: String
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let logger = Logger(subsystem: "moments", category: "highlights")

    public init(
        slug: EventSlug, reactorID: String, service: any MomentsService, store: any EventCredentialStore,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.slug = slug
        self.reactorID = reactorID
        self.service = service
        self.store = store
        self.now = now
    }

    /// When the tab appears: loads unless it loaded moments ago.
    public func loadIfStale() async {
        guard throttle.isStale(at: now()) else { return }
        await load()
    }

    /// Pull to refresh.
    public func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        await load()
    }

    @discardableResult
    public func setReacted(_ reacted: Bool, onMomentID id: String) -> Task<Void, Never>? {
        reactionSenders.setReacted(reacted, onMomentID: id)
    }

    @discardableResult
    public func toggleReaction(onMomentID id: String) -> Task<Void, Never>? {
        reactionSenders.toggle(onMomentID: id)
    }

    /// This device's state learned from the feed.
    public func applyServerReaction(momentID: String, state reaction: ReactionState) {
        state.applyServerReaction(forMomentID: momentID, reacted: reaction.reacted, reactionCount: reaction.reactionCount)
        moments = state.moments
    }

    /// The event ended for this guest (the feed lost access): stop.
    public func end() {
        hasEnded = true
        reactionSenders.cancelAll()
    }

    private func load() async {
        guard !isLoading, !hasEnded else { return }
        isLoading = true
        defer { isLoading = false }
        if !state.hasLoaded { phase = .loading }
        do {
            let loaded = try await service.highlights(
                slug: slug.value, limit: Self.limit, reactorID: reactorID,
                credentials: eventCredentials(store: store, slug: slug)
            )
            state.replace(with: loaded)
            moments = state.moments
            throttle.markLoaded(at: now())
            phase = .loaded
        } catch {
            failed(error)
        }
    }

    private func failed(_ error: any Error) {
        switch error {
        case is CancellationError:
            break
        case MomentsAPIError.accessRequired, MomentsAPIError.eventNotFound:
            end()
            onFatalError?(error)
        default:
            if !(error is MomentsAPIError) {
                logger.error("highlights failed: \(String(describing: error), privacy: .public)")
            }
        }
        // Rate limits and network trouble keep what is shown.
        if !state.hasLoaded { phase = .failed }
    }
}

extension HighlightsModel: ReactionHost {
    var reactionList: HighlightsState {
        get { state }
        set { state = newValue }
    }

    var acceptsReactions: Bool { phase == .loaded && !hasEnded }

    func sendReaction(_ reacted: Bool, momentID: String) async throws -> ReactionState {
        try await service.setReaction(
            reacted, slug: slug.value, momentID: momentID, reactorID: reactorID,
            credentials: eventCredentials(store: store, slug: slug)
        )
    }

    func reactionListDidChange() {
        moments = state.moments
    }

    func reactionDidSettle(momentID: String, state reaction: ReactionState) {
        onReactionSettled?(momentID, reaction)
    }

    func reactionDidFail(momentID: String, error: any Error) {
        switch error {
        case is CancellationError:
            return
        case MomentsAPIError.accessRequired, MomentsAPIError.eventNotFound:
            end()
            onFatalError?(error)
        case MomentsAPIError.momentNotFound:
            // Hidden or deleted meanwhile.
            reactionFailureCount += 1
            state.remove([momentID])
            moments = state.moments
        default:
            reactionFailureCount += 1
            if !(error is MomentsAPIError) {
                logger.error("reaction failed: \(String(describing: error), privacy: .public)")
            }
        }
    }
}
