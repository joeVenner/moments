import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Observation
import OSLog

/// Guests ranked by points, with this guest's place. Loads like highlights
/// (when shown, unless fresh; on pull to refresh).
@MainActor @Observable
public final class LeaderboardModel {
    /// Podium size.
    public static let podiumSize = 3

    public private(set) var phase: EventReadPhase = .loading
    public private(set) var isRefreshing = false
    public private(set) var entries: [LeaderboardEntry] = []
    /// Bumped when this guest reaches the podium (on the first load too), for
    /// a celebration. Not bumped by reloads that keep them there.
    public private(set) var podiumCelebrations = 0

    @ObservationIgnored public var onFatalError: (@MainActor (any Error) -> Void)?

    public let participantID: String
    @ObservationIgnored private var throttle = ReloadThrottle()
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var hasEnded = false
    @ObservationIgnored private var wasOnPodium: Bool?
    @ObservationIgnored private let service: any MomentsService
    @ObservationIgnored private let store: any EventCredentialStore
    @ObservationIgnored private let slug: EventSlug
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let logger = Logger(subsystem: "moments", category: "leaderboard")

    public init(
        slug: EventSlug, participantID: String, service: any MomentsService, store: any EventCredentialStore,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.slug = slug
        self.participantID = participantID
        self.service = service
        self.store = store
        self.now = now
    }

    /// The first three by position (ranks can tie: 1, 1, 3).
    public var podium: ArraySlice<LeaderboardEntry> { entries.prefix(Self.podiumSize) }
    public var others: ArraySlice<LeaderboardEntry> { entries.dropFirst(Self.podiumSize) }
    /// This guest's points; 0 until they're on the board.
    public var myPoints: Int { entries.first { $0.participantID == participantID }?.totalPoints ?? 0 }
    public var myEntry: LeaderboardEntry? { entries.first { $0.participantID == participantID } }

    public func loadIfStale() async {
        guard throttle.isStale(at: now()) else { return }
        await load()
    }

    public func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        await load()
    }

    public func end() {
        hasEnded = true
    }

    /// Joins a load in flight (see `HighlightsModel.load`).
    private func load() async {
        if let loadTask { return await loadTask.value }
        guard !hasEnded else { return }
        let task = Task { await performLoad() }
        loadTask = task
        await task.value
        loadTask = nil
    }

    private func performLoad() async {
        if phase != .loaded { phase = .loading }
        do {
            let loaded = try await service.leaderboard(slug: slug.value, credentials: eventCredentials(store: store, slug: slug))
            entries = loaded
            throttle.markLoaded(at: now())
            phase = .loaded
            let onPodium = podium.contains { $0.participantID == participantID }
            if onPodium, wasOnPodium != true { podiumCelebrations += 1 }
            wasOnPodium = onPodium
        } catch {
            switch error {
            case is CancellationError:
                return
            case MomentsAPIError.accessRequired, MomentsAPIError.eventNotFound, MomentsAPIError.eventNotHosted:
                end()
                onFatalError?(error)
            case MomentsAPIError.rateLimited:
                throttle.markLoaded(at: now())
            default:
                if !(error is MomentsAPIError) {
                    logger.error("leaderboard failed: \(String(describing: error), privacy: .public)")
                }
            }
            if phase != .loaded { phase = .failed }
        }
    }
}
