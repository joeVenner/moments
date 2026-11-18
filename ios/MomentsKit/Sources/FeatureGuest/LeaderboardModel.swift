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
    @ObservationIgnored private var isLoading = false
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

    private func load() async {
        guard !isLoading, !hasEnded else { return }
        isLoading = true
        defer { isLoading = false }
        if entries.isEmpty, phase != .loaded { phase = .loading }
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
                break
            case MomentsAPIError.accessRequired, MomentsAPIError.eventNotFound:
                end()
                onFatalError?(error)
            default:
                if !(error is MomentsAPIError) {
                    logger.error("leaderboard failed: \(String(describing: error), privacy: .public)")
                }
            }
            if phase != .loaded { phase = .failed }
        }
    }
}
