import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Observation
import OSLog

/// The guest feed for one joined event: first page, older pages as the guest
/// scrolls, pull to refresh, and polling for changes. New moments from a poll
/// are counted ("N new moments") rather than inserted under the guest's
/// thumb; removals (hidden by the host) apply at once.
@MainActor @Observable
public final class FeedModel {
    public enum Phase: Equatable, Sendable {
        case loading
        case loaded
        case failed(Failure)
        /// The event's access changed (new PIN, made private): join again.
        case accessLost
    }

    public enum Failure: Equatable, Sendable {
        /// Network or server trouble; `loadFirstPage()` tries again.
        case temporary
        /// The event no longer exists.
        case eventGone
    }

    public static let pageSize = 60
    /// Changes batches drained per poll before waiting for the next one.
    static let maxBatchesPerPoll = 5

    public let event: Event
    public let participant: Participant
    public private(set) var phase: Phase = .loading
    public private(set) var isRefreshing = false
    public private(set) var isLoadingOlder = false
    /// The last older-page request failed; scrolling to the end retries.
    public private(set) var olderPageFailed = false
    /// The last pull to refresh failed (the grid kept what it had).
    public private(set) var refreshFailed = false
    /// What the grid shows, newest first; recomputed when the feed changes.
    public private(set) var moments: [Moment] = []
    /// Arrived since the guest last looked; shown on the "new moments" pill.
    public private(set) var newMomentCount = 0
    /// Bumped when a reaction is refused and rolled back (for an error haptic).
    public private(set) var reactionFailureCount = 0
    /// Called when the server confirms a heart, so other lists can follow.
    @ObservationIgnored public var onReactionSettled: (@MainActor (_ momentID: String, _ state: ReactionState) -> Void)?

    /// Moments newer than this aren't shown until revealed; nil shows all.
    @ObservationIgnored private var revealedThroughSeq: Int?
    @ObservationIgnored private var feed = FeedState()
    /// Bumped by every first-page load: an older page requested before it
    /// belongs to a window that no longer exists and is dropped.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var olderTask: Task<Void, Never>?
    @ObservationIgnored private var currentSync: Task<Bool, Never>?
    @ObservationIgnored private lazy var reactionSenders = ReactionSenders(host: self)
    @ObservationIgnored private let grantCache: GrantCache

    @ObservationIgnored private let service: any MomentsService
    @ObservationIgnored private let store: any EventCredentialStore
    @ObservationIgnored private let slug: EventSlug
    @ObservationIgnored private let reactorID: String
    /// One sync (first page, refresh, poll) at a time, per FeedState's contract.
    @ObservationIgnored private var isSyncing = false
    @ObservationIgnored private let logger = Logger(subsystem: "moments", category: "feed")

    public init(
        event: Event, participant: Participant, slug: EventSlug, reactorID: String,
        service: any MomentsService, store: any EventCredentialStore
    ) {
        self.event = event
        self.participant = participant
        self.slug = slug
        self.reactorID = reactorID
        self.service = service
        self.store = store
        grantCache = GrantCache(store: store, slug: slug)
    }

    // MARK: - What the grid shows

    public var canLoadOlder: Bool { feed.canLoadOlder }

    /// The grant for media requests on a private event (nil when public).
    /// Cached briefly: every thumbnail asks for it.
    public nonisolated func mediaAccessGrant() -> String? {
        grantCache.grant()
    }

    private func updateVisible() {
        guard let revealedThroughSeq else {
            moments = feed.moments
            newMomentCount = 0
            return
        }
        var shown: [Moment] = []
        shown.reserveCapacity(feed.moments.count)
        var hidden = 0
        for moment in feed.moments {
            if moment.seq <= revealedThroughSeq { shown.append(moment) } else { hidden += 1 }
        }
        moments = shown
        newMomentCount = hidden
    }

    // MARK: - Intents

    /// Initial load, and the retry after a failure.
    public func loadFirstPage() async {
        guard phase == .loading || phase == .failed(.temporary), !isSyncing else { return }
        phase = .loading
        await sync(waitIfBusy: false) { [self] in
            try await replaceWithFirstPage(revealAll: true)
            phase = .loaded
        }
    }

    /// Pull to refresh: reloads from the top and shows everything.
    public func refresh() async {
        guard phase == .loaded, !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        refreshFailed = false
        // Waits for a running poll instead of silently doing nothing.
        let succeeded = await sync(waitIfBusy: true) { [self] in try await replaceWithFirstPage(revealAll: true) }
        refreshFailed = !succeeded && phase == .loaded && !Task.isCancelled
    }

    /// Fetches changes since the last sync. Silent on network trouble (the
    /// next poll tries again).
    public func poll() async {
        guard phase == .loaded else { return }
        await sync(waitIfBusy: false) { [self] in
            for _ in 0..<Self.maxBatchesPerPoll {
                guard let cursor = feed.cursor else { return try await replaceWithFirstPage(revealAll: false) }
                let changes = try await service.feedChanges(
                    slug: slug.value, since: cursor, limit: nil, reactorID: reactorID, credentials: credentials()
                )
                let outcome = feed.applyChanges(
                    upserts: changes.upserts, removed: changes.removed, cursor: changes.cursor, hasMore: changes.hasMore
                )
                switch outcome {
                case .upToDate: return revealIfNothingShown()
                case .moreAvailable: continue
                case .needsReload: return try await replaceWithFirstPage(revealAll: false)
                }
            }
            revealIfNothingShown()
        }
    }

    /// Polls every `interval` until the task is cancelled (the view goes away).
    public func pollUntilCancelled(every interval: Duration = .seconds(15)) async {
        // Ends with the task, or once the feed can't be polled any more.
        while !Task.isCancelled, phase == .loaded || phase == .loading {
            do {
                try await Task.sleep(for: interval)
            } catch {
                return
            }
            await poll()
        }
    }

    public func revealNewMoments() {
        revealedThroughSeq = feed.moments.map(\.seq).max()
        updateVisible()
    }

    /// Call as cells appear; starts the next older page near the end. The
    /// request belongs to the model, not the cell, so scrolling the cell
    /// away doesn't cancel it.
    @discardableResult
    public func loadOlderIfNeeded(near moment: Moment) -> Task<Void, Never>? {
        guard let last = moments.last, moments.count <= 12 || moment.seq <= moments[moments.count - 12].seq,
              moment.seq >= last.seq
        else { return nil }
        return startLoadingOlder()
    }

    /// The "try again" after an older page failed.
    @discardableResult
    public func retryOlder() -> Task<Void, Never>? {
        startLoadingOlder()
    }

    /// One model-owned older-page task at a time; it clears itself however
    /// `loadOlder` ends, so loading can never get stuck.
    private func startLoadingOlder() -> Task<Void, Never>? {
        guard olderTask == nil, !isLoadingOlder, phase == .loaded, feed.canLoadOlder else { return nil }
        let task = Task { [self] in
            await loadOlder()
            olderTask = nil
        }
        olderTask = task
        return task
    }

    public func loadOlder() async {
        guard phase == .loaded, feed.canLoadOlder, !isLoadingOlder, let before = feed.nextBefore else { return }
        isLoadingOlder = true
        let requestedIn = generation
        defer { isLoadingOlder = false }
        do {
            let page = try await service.feedPage(
                slug: slug.value, before: before, limit: Self.pageSize, reactorID: reactorID, credentials: credentials()
            )
            // A refresh replaced the window meanwhile: this page would leave a gap.
            guard requestedIn == generation else { return }
            feed.appendOlderPage(page.moments, nextBefore: page.nextBefore)
            olderPageFailed = false
            updateVisible()
        } catch is CancellationError {
            return
        } catch {
            handle(error, isBackground: true)
            olderPageFailed = phase == .loaded
        }
    }

    // MARK: - Reactions

    /// Hearts or un-hearts a moment at once; the request follows. Taps while
    /// a request is in flight are coalesced: the last one wins.
    @discardableResult
    public func setReacted(_ reacted: Bool, onMomentID id: String) -> Task<Void, Never>? {
        reactionSenders.setReacted(reacted, onMomentID: id)
    }

    @discardableResult
    public func toggleReaction(onMomentID id: String) -> Task<Void, Never>? {
        reactionSenders.toggle(onMomentID: id)
    }

    /// This device's state learned from another list (e.g. highlights).
    public func applyServerReaction(momentID: String, state: ReactionState) {
        feed.applyServerReaction(forMomentID: momentID, reacted: state.reacted, reactionCount: state.reactionCount)
        updateVisible()
    }

    /// Another screen of this event hit an error that ends it (access lost,
    /// event deleted). Returns whether it did.
    @discardableResult
    public func endIfFatal(_ error: any Error) -> Bool {
        switch error {
        case MomentsAPIError.accessRequired, MomentsAPIError.eventNotFound:
            handle(error, isBackground: true)
            return true
        default:
            return false
        }
    }

    // MARK: - Steps

    private func replaceWithFirstPage(revealAll: Bool) async throws {
        let page = try await service.feedPage(
            slug: slug.value, before: nil, limit: Self.pageSize, reactorID: reactorID, credentials: credentials()
        )
        generation += 1
        feed.replace(withFirstPage: page.moments, nextBefore: page.nextBefore, cursor: page.cursor)
        olderPageFailed = false
        if revealAll || revealedThroughSeq == nil { revealNewMoments() }
        revealIfNothingShown()
    }

    /// An empty grid has nothing to keep steady: show arrivals straight away.
    private func revealIfNothingShown() {
        updateVisible()
        if moments.isEmpty { revealNewMoments() }
    }

    private func credentials() throws -> EventCredentials {
        try eventCredentials(store: store, slug: slug)
    }

    /// Runs one sync at a time (FeedState's contract). Returns whether the
    /// step completed.
    @discardableResult
    private func sync(waitIfBusy: Bool, _ step: @escaping () async throws -> Void) async -> Bool {
        // The running task clears `isSyncing`/`currentSync` itself before it
        // completes, so a waiter always finds the slot free or a newer sync.
        while isSyncing {
            guard waitIfBusy, let running = currentSync else { return false }
            _ = await running.value
        }
        isSyncing = true
        let task = Task { [self] () -> Bool in
            defer {
                isSyncing = false
                currentSync = nil
            }
            do {
                try await step()
                return true
            } catch {
                handle(error, isBackground: phase == .loaded)
                return false
            }
        }
        currentSync = task
        // Leaving the screen still cancels the request.
        return await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
    }

    /// Background work (polls, older pages, refresh) keeps the grid on
    /// transient errors; only lost access or a deleted event end it.
    private func handle(_ error: any Error, isBackground: Bool) {
        switch error {
        case is CancellationError:
            if phase == .loading { phase = .failed(.temporary) }
        case MomentsAPIError.accessRequired:
            phase = .accessLost
            grantCache.clear()
            reactionSenders.cancelAll()
        case MomentsAPIError.eventNotFound:
            phase = .failed(.eventGone)
            reactionSenders.cancelAll()
        default:
            if !(error is MomentsAPIError) {
                logger.error("feed step failed: \(String(describing: error), privacy: .public)")
            }
            if !isBackground { phase = .failed(.temporary) }
        }
    }
}

/// Remembers the event's grant for a short while so thumbnails don't each
/// read the keychain. Thread-safe: read from the image loader.
final class GrantCache: @unchecked Sendable {
    // @unchecked: all state is behind `lock`.
    private let lock = NSLock()
    private let store: any EventCredentialStore
    private let slug: EventSlug
    private var cached: (grant: String?, until: Date)?
    static let lifetime: TimeInterval = 30
    private let now: @Sendable () -> Date

    init(store: any EventCredentialStore, slug: EventSlug, now: @escaping @Sendable () -> Date = { Date() }) {
        self.store = store
        self.slug = slug
        self.now = now
    }

    func grant() -> String? {
        lock.withLock {
            let now = now()
            if let cached, now < cached.until { return cached.grant }
            // Fails closed: an unreadable store means no grant (the request gets 401).
            let stored = try? store.credentials(for: slug)
            let grant = stored?.validAccessGrant(at: now)
            // Never past the grant's own validity (same 60 s margin as the store).
            var until = now.addingTimeInterval(Self.lifetime)
            if grant != nil, let expiry = stored?.accessGrantExpiresAt {
                until = min(until, expiry.addingTimeInterval(-60))
            }
            cached = (grant, until)
            return grant
        }
    }

    func clear() {
        lock.withLock { cached = nil }
    }
}

extension FeedModel: ReactionHost {
    var reactionList: FeedState {
        get { feed }
        set { feed = newValue }
    }

    var acceptsReactions: Bool { phase == .loaded }

    func sendReaction(_ reacted: Bool, momentID: String) async throws -> ReactionState {
        try await service.setReaction(reacted, slug: slug.value, momentID: momentID, reactorID: reactorID, credentials: credentials())
    }

    func reactionListDidChange() {
        updateVisible()
    }

    func reactionDidSettle(momentID: String, state: ReactionState) {
        onReactionSettled?(momentID, state)
    }

    func reactionDidFail(momentID: String, error: any Error) {
        if error is CancellationError || endIfFatal(error) { return }
        reactionFailureCount += 1
        if case MomentsAPIError.momentNotFound = error {
            // Hidden or deleted meanwhile: a sync takes it off the grid.
            Task { await poll() }
        } else if !(error is MomentsAPIError) {
            logger.error("reaction failed: \(String(describing: error), privacy: .public)")
        }
    }
}
