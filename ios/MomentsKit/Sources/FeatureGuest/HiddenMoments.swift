import CredentialStore
import MomentsDomain
import OSLog

/// What this guest chose not to see, on this device: moments they reported
/// and guests they muted. A report or mute made from the viewer applies when
/// the viewer closes (so the confirmation shows and the page doesn't vanish
/// under the guest).
///
/// Reports only ever add (a report can't be taken back). Mutes follow the
/// store, so an unmute from another screen brings the moments back.
struct HiddenMoments {
    /// Reported moments filtered out of the list.
    private(set) var reportedIDs: Set<String> = []
    /// Muted guests whose moments are filtered out.
    private(set) var mutedIDs: Set<String> = []
    /// Reported or muted from a viewer that is still open.
    private var pendingReports: Set<String> = []
    private var pendingMutes: Set<String> = []
    /// This guest, whose own moments are never hidden by a mute.
    private(set) var ownParticipantID: String?

    init(ownParticipantID: String? = nil) {
        self.ownParticipantID = ownParticipantID
    }

    /// Whether this guest may mute the moment's sharer: not themselves, and
    /// not a moment from before guest ids (no `uploaderID`).
    func canMute(_ moment: Moment) -> Bool {
        guard let uploaderID = moment.uploaderID else { return false }
        return uploaderID != ownParticipantID
    }

    /// Saves the report so every screen (and the next launch) hides it.
    mutating func markReported(_ momentID: String, store: any EventCredentialStore, slug: EventSlug, logger: Logger) {
        pendingReports.insert(momentID)
        do {
            try store.update(for: slug) { $0.rememberReport(of: momentID) }
        } catch {
            logger.error("saving a report failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// Saves the mute so every screen (and the next launch) hides the
    /// guest's moments. Returns false when the store refused it (it still
    /// applies when the viewer closes, until the next reload), and for this
    /// guest, who is never muted (`canMute` keeps that out of the UI).
    @discardableResult
    mutating func markMuted(_ participantID: String, store: any EventCredentialStore, slug: EventSlug, logger: Logger) -> Bool {
        guard participantID != ownParticipantID else { return false }
        pendingMutes.insert(participantID)
        do {
            try store.update(for: slug) { $0.mute(participantID: participantID) }
            return true
        } catch {
            logger.error("saving a mute failed: \(String(describing: error), privacy: .public)")
            return false
        }
    }

    /// Re-reads the store (another screen may have reported, muted or
    /// unmuted), leaving out anything still pending. Returns whether the
    /// list changes. If the store can't be read, nothing changes.
    mutating func reload(store: any EventCredentialStore, slug: EventSlug, logger: Logger) -> Bool {
        guard let saved = Self.saved(store: store, slug: slug, logger: logger) else { return false }
        if let id = saved.participantID { ownParticipantID = id }
        return apply(
            reports: reportedIDs.union(Set(saved.reportedMomentIDs ?? []).subtracting(pendingReports)),
            mutes: Set(saved.mutedParticipantIDs ?? []).subtracting(pendingMutes)
        )
    }

    /// The viewer closed: what was reported or muted from it goes too.
    mutating func applyPending(store: any EventCredentialStore, slug: EventSlug, logger: Logger) -> Bool {
        let saved = Self.saved(store: store, slug: slug, logger: logger)
        let savedMutes = saved.map { Set($0.mutedParticipantIDs ?? []) } ?? mutedIDs
        let changed = apply(
            reports: reportedIDs.union(pendingReports).union(saved?.reportedMomentIDs ?? []),
            mutes: savedMutes.union(pendingMutes)
        )
        pendingReports = []
        pendingMutes = []
        return changed
    }

    func filter(_ moments: [Moment]) -> [Moment] {
        guard !reportedIDs.isEmpty || !mutedIDs.isEmpty else { return moments }
        return moments.filter { !isHidden($0) }
    }

    private func isHidden(_ moment: Moment) -> Bool {
        if reportedIDs.contains(moment.id) { return true }
        // A stray saved id never hides this guest's own moments.
        guard let uploaderID = moment.uploaderID, uploaderID != ownParticipantID else { return false }
        return mutedIDs.contains(uploaderID)
    }

    private mutating func apply(reports: Set<String>, mutes: Set<String>) -> Bool {
        guard reports != reportedIDs || mutes != mutedIDs else { return false }
        reportedIDs = reports
        mutedIDs = mutes
        return true
    }

    private static func saved(store: any EventCredentialStore, slug: EventSlug, logger: Logger) -> StoredEventCredentials? {
        do {
            return try store.credentials(for: slug) ?? StoredEventCredentials()
        } catch {
            logger.error("reading hidden moments failed: \(String(describing: error), privacy: .public)")
            return nil
        }
    }
}
