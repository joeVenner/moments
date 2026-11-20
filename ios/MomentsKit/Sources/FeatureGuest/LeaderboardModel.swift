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
    /// Guests this guest muted on this device, oldest first.
    public private(set) var mutedParticipantIDs: [String] = []
    /// The last unmute couldn't be saved (the guest stays muted).
    public private(set) var unmuteFailed = false

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

    /// The muted guests, named from the board when they're on it.
    public var mutedGuests: [MutedGuest] {
        mutedParticipantIDs.map { id in MutedGuest(id: id, entry: entries.first { $0.participantID == id }) }
    }

    /// Re-reads the mutes (the viewer may have added one), forgetting an
    /// earlier failed unmute.
    public func reloadMuted() {
        unmuteFailed = false
        do {
            mutedParticipantIDs = try store.credentials(for: slug)?.mutedParticipantIDs ?? []
        } catch {
            logger.error("reading mutes failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// Their moments come back once the lists reload.
    public func unmute(participantID: String) {
        do {
            try store.update(for: slug) { $0.unmute(participantID: participantID) }
        } catch {
            logger.error("saving an unmute failed: \(String(describing: error), privacy: .public)")
            reloadMuted()
            unmuteFailed = true
            return
        }
        reloadMuted()
    }

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

/// A guest this guest muted; `entry` is nil when they're not on the board
/// (e.g. they left).
public struct MutedGuest: Identifiable, Hashable, Sendable {
    public let id: String
    public let entry: LeaderboardEntry?
}
