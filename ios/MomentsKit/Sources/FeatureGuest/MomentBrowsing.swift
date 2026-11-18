import MomentsDomain

/// What the full-screen viewer pages through: the feed or highlights.
@MainActor
protocol MomentBrowsing: AnyObject {
    var moments: [Moment] { get }
    /// Bumped when a heart is refused (for an error haptic).
    var reactionFailureCount: Int { get }
    /// False once the list can't be shown (access lost, event gone): the
    /// viewer closes.
    var isBrowsable: Bool { get }
    @discardableResult func setReacted(_ reacted: Bool, onMomentID id: String) -> Task<Void, Never>?
    @discardableResult func toggleReaction(onMomentID id: String) -> Task<Void, Never>?
    /// A page came on screen (the feed loads older moments near the end).
    func momentShown(_ moment: Moment)
}

extension FeedModel: MomentBrowsing {
    // While loaded, the feed only leaves `.loaded` for access lost or a
    // deleted event (transient errors keep the grid), both final.
    var isBrowsable: Bool { phase == .loaded }

    func momentShown(_ moment: Moment) {
        loadOlderIfNeeded(near: moment)
    }
}

extension HighlightsModel: MomentBrowsing {
    var isBrowsable: Bool { phase == .loaded && !hasEnded }

    func momentShown(_ moment: Moment) {}
}
