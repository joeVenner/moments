/// A list of moments in the server's order (most-hearted first) with the
/// same optimistic hearts as the feed. Each load replaces the list; pending
/// toggles survive it like they survive a feed refresh.
public struct HighlightsState: Sendable, Equatable, ReactionList {
    public private(set) var moments: [Moment] = []
    /// False until the first load lands (an empty list then means "none yet").
    public private(set) var hasLoaded = false
    private var reactions = ReactionLedger()

    public init() {}

    /// A fresh load, kept in the order given.
    public mutating func replace(with loaded: [Moment]) {
        reactions.startSync()
        var seen = Set<String>()
        let unique = loaded.filter { seen.insert($0.id).inserted }
        let local = Dictionary(
            moments.filter { reactions.isPending($0.id) && seen.contains($0.id) }.map { ($0.id, ReactionLedger.Snapshot($0)) },
            uniquingKeysWith: { first, _ in first }
        )
        reactions.keepOnly(Set(local.keys))
        moments = unique.map { incoming in
            var moment = incoming
            reactions.overlay(&moment, local: local[moment.id])
            return moment
        }
        hasLoaded = true
        reactions.finishSync()
    }

    /// The host hid or deleted these (learned from the feed).
    public mutating func remove(_ ids: Set<String>) {
        guard !ids.isEmpty else { return }
        moments.removeAll { ids.contains($0.id) }
        reactions.forget(ids)
    }

    @discardableResult
    public mutating func setReacted(_ hasReacted: Bool, forMomentID id: String) -> Bool {
        reactions.setReacted(hasReacted, id: id, in: &moments)
    }

    public func hasUnsentReaction(forMomentID id: String) -> Bool {
        reactions.hasUnsent(id)
    }

    @discardableResult
    public mutating func discardUnsentReactionIfUnchanged(forMomentID id: String) -> Bool {
        reactions.discardUnsentIfUnchanged(id, in: &moments)
    }

    @discardableResult
    public mutating func confirmReaction(forMomentID id: String, reacted: Bool, reactionCount: Int) -> Bool {
        reactions.confirm(id, reacted: reacted, reactionCount: reactionCount, in: &moments)
    }

    public mutating func rollbackReaction(forMomentID id: String) {
        reactions.rollback(id, in: &moments)
    }

    public mutating func applyServerReaction(forMomentID id: String, reacted: Bool, reactionCount: Int) {
        reactions.applyServerState(id, reacted: reacted, reactionCount: reactionCount, in: &moments)
    }
}

/// A list with optimistic hearts (feed, highlights), so one sender loop can
/// drive either. See `ReactionLedger` for the rules.
public protocol ReactionList: Sendable {
    var moments: [Moment] { get }
    /// Returns false when the moment is unknown or already in that state.
    @discardableResult mutating func setReacted(_ hasReacted: Bool, forMomentID id: String) -> Bool
    func hasUnsentReaction(forMomentID id: String) -> Bool
    /// True (and cleared) when the intent is back to the server's last state.
    @discardableResult mutating func discardUnsentReactionIfUnchanged(forMomentID id: String) -> Bool
    /// True when the answer settles the moment; false: send the current intent.
    @discardableResult mutating func confirmReaction(forMomentID id: String, reacted: Bool, reactionCount: Int) -> Bool
    mutating func rollbackReaction(forMomentID id: String)
    /// Server state learned elsewhere; ignored while a toggle is pending here.
    mutating func applyServerReaction(forMomentID id: String, reacted: Bool, reactionCount: Int)
}

extension FeedState: ReactionList {}
