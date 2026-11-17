/// The guest feed as a value: newest-first moments plus the server cursors.
/// Pure, so the merge rules are tested without networking.
///
/// Server contract (src/worker/feed.ts):
/// - `getFeed` pages walk back by `seq`; a page's `cursor` is the change
///   counter *when that page was read*.
/// - `getFeedChanges(since:)` returns everything after `since`, oldest first:
///   upserts (new, edited or re-approved) and `removed` ids (hidden or deleted).
///   A batch holds at most one entry per moment.
/// - `change_seq` tracks visibility and caption only, never reactions.
///
/// Merge rules:
/// - Only the first page (or a refresh, which replaces everything) sets the
///   sync cursor. Older pages never move it, or changes after the first page's
///   snapshot would be skipped.
/// - Removed ids are remembered: a page read before the removal cannot bring
///   the moment back. Only a later changes upsert (re-approval) can.
/// - A pending optimistic reaction is never overwritten by server rows; it is
///   confirmed or rolled back explicitly, and after confirmation it survives
///   one more sync (that sync may have been read before the request landed).
///
/// Caller contract: run syncs (`replace`/`applyChanges`) one at a time, and
/// `appendOlderPage` calls one at a time, newest bound first. Changes may
/// upsert moments older than the loaded window; they show up in place.
public struct FeedState: Sendable, Equatable {
    /// What a changes batch means for the caller's sync loop.
    public enum ChangesOutcome: Sendable, Equatable {
        /// Up to date; poll again later.
        case upToDate
        /// More changes are waiting: call `getFeedChanges` again right away.
        case moreAvailable
        /// The server's counter is behind ours (e.g. restored database):
        /// reload the first page and `replace` the state.
        case needsReload
    }

    public private(set) var moments: [Moment] = []
    /// Pass as `before` to load older moments; nil once the oldest page is in.
    public private(set) var nextBefore: Int?
    /// Pass as `since` to `getFeedChanges`; nil until the first page arrives.
    public private(set) var cursor: Int?

    private var removedIDs: Set<String> = []
    /// Reaction state last reported by the server, for ids with a pending toggle.
    private var pendingReactions: [String: PendingReaction] = [:]
    /// Ids that were already confirmed when the previous sync finished.
    private var confirmedAtLastSync: Set<String> = []

    private struct ReactionSnapshot: Sendable, Equatable {
        var hasReacted: Bool
        var reactionCount: Int
    }

    private struct PendingReaction: Sendable, Equatable {
        /// What the server last reported, restored by a rollback.
        var server: ReactionSnapshot
        /// False while the request is in flight; true once confirmed.
        var isConfirmed = false
    }

    public init() {}

    public var hasLoadedFirstPage: Bool { cursor != nil }
    public var canLoadOlder: Bool { hasLoadedFirstPage && nextBefore != nil }

    /// First page or pull-to-refresh: replaces everything, including the
    /// cursor. Pending reactions survive so a refresh mid-request keeps them.
    public mutating func replace(withFirstPage page: [Moment], nextBefore: Int?, cursor: Int) {
        startSync()
        let pending = pendingReactions
        let confirmed = confirmedAtLastSync
        let localReactions = Dictionary(
            moments.filter { pending[$0.id] != nil }.map { ($0.id, ReactionSnapshot(hasReacted: $0.hasReacted, reactionCount: $0.reactionCount)) },
            uniquingKeysWith: { first, _ in first }
        )
        self = FeedState()
        self.nextBefore = nextBefore
        self.cursor = cursor
        // Only moments still on the new page keep their pending toggle.
        let pageIDs = Set(page.map(\.id))
        pendingReactions = pending.filter { localReactions[$0.key] != nil && pageIDs.contains($0.key) }
        confirmedAtLastSync = confirmed.intersection(pageIDs)
        merge(page, isAuthoritative: true, localReactions: localReactions)
        finishSync()
    }

    /// An older page (`getFeed(before:)`). Never moves the sync cursor, and
    /// only ever moves `nextBefore` further back.
    public mutating func appendOlderPage(_ page: [Moment], nextBefore: Int?) {
        guard hasLoadedFirstPage else { return }
        if let current = self.nextBefore {
            // nil = reached the oldest moment; otherwise keep the smallest bound.
            self.nextBefore = nextBefore.map { min($0, current) }
        }
        merge(page, isAuthoritative: false)
    }

    /// Applies a `getFeedChanges` batch and tells the caller what to do next.
    @discardableResult
    public mutating func applyChanges(
        upserts: [Moment], removed: [String], cursor newCursor: Int, hasMore: Bool
    ) -> ChangesOutcome {
        // Before the first page there is nothing to apply changes to; after a
        // server rewind the content is stale. Either way, `replace` first.
        guard let current = cursor, newCursor >= current else {
            cursor = nil
            return .needsReload
        }
        startSync()
        if !removed.isEmpty {
            let gone = Set(removed)
            moments.removeAll { gone.contains($0.id) }
            removedIDs.formUnion(gone)
            for id in gone { pendingReactions[id] = nil }
        }
        // Changes are newer than anything a page could hold.
        removedIDs.subtract(upserts.map(\.id))
        merge(upserts, isAuthoritative: true)
        cursor = newCursor
        finishSync()
        return hasMore ? .moreAvailable : .upToDate
    }

    /// Optimistic reaction toggle. Returns false (and changes nothing) when the
    /// moment is unknown, already in that state, or still has a request in
    /// flight: one request per moment at a time, so send one only on `true`.
    @discardableResult
    public mutating func setReacted(_ hasReacted: Bool, forMomentID id: String) -> Bool {
        guard let index = moments.firstIndex(where: { $0.id == id }),
              moments[index].hasReacted != hasReacted,
              pendingReactions[id]?.isConfirmed != false else { return false }
        let server = pendingReactions[id]?.server
            ?? ReactionSnapshot(hasReacted: moments[index].hasReacted, reactionCount: moments[index].reactionCount)
        pendingReactions[id] = PendingReaction(server: server)
        moments[index].hasReacted = hasReacted
        moments[index].reactionCount = max(0, moments[index].reactionCount + (hasReacted ? 1 : -1))
        return true
    }

    /// The reaction request succeeded. The toggle is kept through the next
    /// sync, then server values take over again.
    public mutating func confirmReaction(forMomentID id: String) {
        pendingReactions[id]?.isConfirmed = true
    }

    /// The reaction request failed: restore what the server last reported.
    public mutating func rollbackReaction(forMomentID id: String) {
        guard let snapshot = pendingReactions.removeValue(forKey: id)?.server,
              let index = moments.firstIndex(where: { $0.id == id }) else { return }
        moments[index].hasReacted = snapshot.hasReacted
        moments[index].reactionCount = snapshot.reactionCount
    }

    /// - Parameter isAuthoritative: first-page and changes rows replace what we
    ///   hold; older-page rows only fill gaps or carry a newer `changeSeq`.
    ///   `localReactions` carries pending toggles across a `replace`.
    private mutating func merge(
        _ incoming: [Moment], isAuthoritative: Bool, localReactions: [String: ReactionSnapshot] = [:]
    ) {
        guard !incoming.isEmpty else { return }
        var byID = Dictionary(moments.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for var moment in incoming where !removedIDs.contains(moment.id) {
            if let existing = byID[moment.id] {
                let isNewer = moment.changeSeq > existing.changeSeq
                if !isAuthoritative && !isNewer { continue }
                if isAuthoritative && moment.changeSeq < existing.changeSeq { continue }
            }
            let local = localReactions[moment.id]
                ?? byID[moment.id].map { ReactionSnapshot(hasReacted: $0.hasReacted, reactionCount: $0.reactionCount) }
            if pendingReactions[moment.id] != nil, let local {
                // Remember the server's view for a rollback, keep the local toggle.
                pendingReactions[moment.id]?.server = ReactionSnapshot(
                    hasReacted: moment.hasReacted, reactionCount: moment.reactionCount
                )
                moment.hasReacted = local.hasReacted
                moment.reactionCount = local.reactionCount
            }
            byID[moment.id] = moment
        }
        // seq is unique per event; id breaks ties so the order is deterministic.
        moments = byID.values.sorted { ($0.seq, $0.id) > ($1.seq, $1.id) }
    }

    /// Toggles confirmed before the previous sync have outlived one sync, so
    /// this sync's server values apply to them.
    private mutating func startSync() {
        for id in confirmedAtLastSync where pendingReactions[id]?.isConfirmed == true {
            pendingReactions[id] = nil
        }
    }

    private mutating func finishSync() {
        confirmedAtLastSync = Set(pendingReactions.filter(\.value.isConfirmed).keys)
    }
}
