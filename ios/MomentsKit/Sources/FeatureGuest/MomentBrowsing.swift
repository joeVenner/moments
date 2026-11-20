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
    /// Reports a moment to the host. An answer that ends the event ends
    /// the screen too (so the viewer closes).
    func report(momentID: String) async -> ReportOutcome
    /// Whether this guest may mute the moment's sharer (not themselves,
    /// and only moments that name one).
    func canMute(_ moment: Moment) -> Bool
    /// Hides the guest's moments on this device, from when the viewer closes.
    func mute(participantID: String)
    /// The viewer closed: moments reported or muted from it leave the list.
    func viewerDidClose()
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
