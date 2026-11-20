import CredentialStore
import MomentsDomain
import OSLog

/// The moments this guest reported, hidden from them on this device. A
/// moment reported from the viewer stays until the viewer closes (so the
/// "thanks" message shows and the page doesn't vanish under the guest).
struct ReportHiding {
    /// Filtered out of the list.
    private(set) var hiddenIDs: Set<String> = []
    /// Reported from a viewer that is still open.
    private var pendingIDs: Set<String> = []

    /// Saves the report so every screen (and the next launch) hides it.
    mutating func markReported(_ momentID: String, store: any EventCredentialStore, slug: EventSlug, logger: Logger) {
        pendingIDs.insert(momentID)
        do {
            try store.update(for: slug) { $0.rememberReport(of: momentID) }
        } catch {
            logger.error("saving a report failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// Re-reads the saved reports (another screen may have added some),
    /// leaving out any still pending. Returns whether the hidden set changed.
    mutating func reload(store: any EventCredentialStore, slug: EventSlug, logger: Logger) -> Bool {
        let saved = Self.saved(store: store, slug: slug, logger: logger).subtracting(pendingIDs)
        // Reports saved before stay hidden even if the store can't be read now.
        let updated = hiddenIDs.union(saved)
        guard updated != hiddenIDs else { return false }
        hiddenIDs = updated
        return true
    }

    /// The viewer closed: its reported moments go too.
    mutating func applyPending(store: any EventCredentialStore, slug: EventSlug, logger: Logger) -> Bool {
        let updated = hiddenIDs.union(pendingIDs).union(Self.saved(store: store, slug: slug, logger: logger))
        pendingIDs = []
        guard updated != hiddenIDs else { return false }
        hiddenIDs = updated
        return true
    }

    func filter(_ moments: [Moment]) -> [Moment] {
        hiddenIDs.isEmpty ? moments : moments.filter { !hiddenIDs.contains($0.id) }
    }

    private static func saved(store: any EventCredentialStore, slug: EventSlug, logger: Logger) -> Set<String> {
        do {
            return Set(try store.credentials(for: slug)?.reportedMomentIDs ?? [])
        } catch {
            logger.error("reading reports failed: \(String(describing: error), privacy: .public)")
            return []
        }
    }
}
