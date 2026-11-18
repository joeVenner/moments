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
/// - The guest may toggle again while a request is in flight; the request's
///   answer then doesn't settle the moment and the caller sends the new
///   intent (the endpoints are idempotent, so the last one sent wins).
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
    private var reactions = ReactionLedger()

    public init() {}

    public var hasLoadedFirstPage: Bool { cursor != nil }
    public var canLoadOlder: Bool { hasLoadedFirstPage && nextBefore != nil }

    /// First page or pull-to-refresh: replaces everything, including the
    /// cursor. Pending reactions survive so a refresh mid-request keeps them.
    public mutating func replace(withFirstPage page: [Moment], nextBefore: Int?, cursor: Int) {
        reactions.startSync()
        var ledger = reactions
        // Only moments still on the new page keep their pending toggle.
        let pageIDs = Set(page.map(\.id))
        let localReactions = Dictionary(
            moments.filter { ledger.isPending($0.id) && pageIDs.contains($0.id) }.map { ($0.id, ReactionLedger.Snapshot($0)) },
            uniquingKeysWith: { first, _ in first }
        )
        ledger.keepOnly(Set(localReactions.keys))
        self = FeedState()
        self.nextBefore = nextBefore
        self.cursor = cursor
        reactions = ledger
        merge(page, isAuthoritative: true, localReactions: localReactions)
        reactions.finishSync()
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
        reactions.startSync()
        if !removed.isEmpty {
            let gone = Set(removed)
            moments.removeAll { gone.contains($0.id) }
            removedIDs.formUnion(gone)
            reactions.forget(gone)
        }
        // Changes are newer than anything a page could hold.
        removedIDs.subtract(upserts.map(\.id))
        merge(upserts, isAuthoritative: true)
        cursor = newCursor
        reactions.finishSync()
        return hasMore ? .moreAvailable : .upToDate
    }

    /// Optimistic reaction toggle. Returns false (and changes nothing) when the
    /// moment is unknown or already in that state. Allowed while a request is
    /// in flight: the caller keeps one request per moment and sends the
    /// current intent again when `confirmReaction` says it hasn't settled.
    @discardableResult
    public mutating func setReacted(_ hasReacted: Bool, forMomentID id: String) -> Bool {
        reactions.setReacted(hasReacted, id: id, in: &moments)
    }

    /// Whether the moment has a reaction the server hasn't answered yet.
    public func hasUnsentReaction(forMomentID id: String) -> Bool {
        reactions.hasUnsent(id)
    }

    /// Before sending: when the guest's intent is back to what the server
    /// last reported (on, then off, before anything was sent), there is
    /// nothing to send. Clears the pending toggle and returns true.
    @discardableResult
    public mutating func discardUnsentReactionIfUnchanged(forMomentID id: String) -> Bool {
        reactions.discardUnsentIfUnchanged(id, in: &moments)
    }

    /// The server answered a reaction request with its state for this device.
    /// Returns true when that settles the moment (or there is nothing pending:
    /// it was removed or refreshed away). Returns false when the guest toggled
    /// again meanwhile: send the moment's current `hasReacted` next.
    ///
    /// A settling answer's count is shown and kept through the next sync,
    /// then server rows take over again.
    @discardableResult
    public mutating func confirmReaction(forMomentID id: String, reacted: Bool, reactionCount: Int) -> Bool {
        reactions.confirm(id, reacted: reacted, reactionCount: reactionCount, in: &moments)
    }

    /// The reaction request failed: restore what the server last reported.
    public mutating func rollbackReaction(forMomentID id: String) {
        reactions.rollback(id, in: &moments)
    }

    /// The server's state for this device learned elsewhere (e.g. hearted
    /// from highlights). Ignored while this list has its own pending toggle.
    public mutating func applyServerReaction(forMomentID id: String, reacted: Bool, reactionCount: Int) {
        reactions.applyServerState(id, reacted: reacted, reactionCount: reactionCount, in: &moments)
    }

    /// - Parameter isAuthoritative: first-page and changes rows replace what we
    ///   hold; older-page rows only fill gaps or carry a newer `changeSeq`.
    ///   `localReactions` carries pending toggles across a `replace`.
    private mutating func merge(
        _ incoming: [Moment], isAuthoritative: Bool, localReactions: [String: ReactionLedger.Snapshot] = [:]
    ) {
        guard !incoming.isEmpty else { return }
        var byID = Dictionary(moments.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for var moment in incoming where !removedIDs.contains(moment.id) {
            if let existing = byID[moment.id] {
                let isNewer = moment.changeSeq > existing.changeSeq
                if !isAuthoritative && !isNewer { continue }
                if isAuthoritative && moment.changeSeq < existing.changeSeq { continue }
            }
            reactions.overlay(&moment, local: localReactions[moment.id] ?? byID[moment.id].map(ReactionLedger.Snapshot.init))
            byID[moment.id] = moment
        }
        // seq is unique per event; id breaks ties so the order is deterministic.
        moments = byID.values.sorted { ($0.seq, $0.id) > ($1.seq, $1.id) }
    }
}
