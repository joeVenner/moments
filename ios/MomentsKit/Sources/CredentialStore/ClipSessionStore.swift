import Foundation
import MomentsDomain
import OSLog

/// The App Clip's store: the guest lives in memory for the session, and each
/// change is copied to `mirror` (the handover file the app picks up) when it
/// can be. A copy that fails (a locked phone, a damaged file) is logged and
/// never stops the guest joining or using the event in the Clip; it only
/// means the app may not pick them up. An event the session hasn't touched
/// is read from the mirror, so a relaunched Clip remembers its guest.
///
/// Failed copies are retried before the next change, so the file catches
/// up with the session. Until a failed "forget" reaches the file, nothing
/// is read back from it: a guest who left can't come back from a stale copy.
public final class ClipSessionStore: EventCredentialStore, @unchecked Sendable {
    // @unchecked: all mutable state is guarded by `lock`; `mirror` serialises itself.
    private let mirror: (any EventCredentialStore)?
    private let session = InMemoryEventCredentialStore()
    private let lock = NSLock()
    /// Slugs read from the mirror (or written by this session) already.
    private var loaded: Set<EventSlug> = []
    /// Slugs whose last copy failed: retried before the next change.
    private var unsynced: Set<EventSlug> = []
    /// Slugs the mirror couldn't read: their file entry may hold a guest
    /// token, so only an entry with a token of its own replaces it.
    private var unreadable: Set<EventSlug> = []
    /// "Forget me" hasn't reached the file yet.
    private var isPurgePending = false
    private let log = Logger(subsystem: "moments", category: "clip-handover")

    public init(mirror: (any EventCredentialStore)?) {
        self.mirror = mirror
    }

    public func credentials(for slug: EventSlug) -> StoredEventCredentials? {
        lock.withLock {
            load(slug)
            return session.credentials(for: slug)
        }
    }

    public func save(_ credentials: StoredEventCredentials, for slug: EventSlug) {
        lock.withLock {
            retryFailedCopies()
            loaded.insert(slug)
            session.save(credentials, for: slug)
            copy(slug)
        }
    }

    public func update(for slug: EventSlug, _ change: (inout StoredEventCredentials) -> Void) {
        lock.withLock {
            retryFailedCopies()
            load(slug)
            let before = session.credentials(for: slug)
            session.update(for: slug, change)
            if session.credentials(for: slug) != before { copy(slug) }
        }
    }

    /// Throws `ForgetNotCopied` when the handover file may still hold the
    /// entry (it is retried before the next change), so a guest leaving is
    /// told rather than the app importing them later.
    public func removeCredentials(for slug: EventSlug) throws {
        try lock.withLock {
            retryFailedCopies()
            loaded.insert(slug)
            session.removeCredentials(for: slug)
            // Forgetting removes the file's entry even if it couldn't be
            // read: whatever token it holds is the guest's who is leaving.
            unreadable.remove(slug)
            copy(slug)
            if unsynced.contains(slug) { throw ForgetNotCopied() }
        }
    }

    public struct ForgetNotCopied: Error, Equatable {}

    public func removeAll() {
        lock.withLock {
            session.removeAll()
            // Whatever the file still holds is forgotten, not reloaded.
            unsynced.removeAll()
            unreadable.removeAll()
            isPurgePending = true
            purgeMirror()
        }
    }

    public func storedSlugs() -> [EventSlug] {
        lock.withLock {
            // `load` reads nothing while "forget me" is pending.
            if let mirror {
                do {
                    try mirror.storedSlugs().forEach(load)
                } catch {
                    report(error)
                }
            }
            return session.storedSlugs()
        }
    }

    // MARK: - Unlocked helpers (callers hold `lock`)

    private func load(_ slug: EventSlug) {
        guard let mirror, !isPurgePending, !loaded.contains(slug) else { return }
        do {
            if let stored = try mirror.credentials(for: slug) { session.save(stored, for: slug) }
            loaded.insert(slug)
            unreadable.remove(slug)
        } catch {
            // Tried again on the next read; meanwhile the session starts empty.
            unreadable.insert(slug)
            report(error)
        }
    }

    private func retryFailedCopies() {
        if isPurgePending { purgeMirror() }
        unsynced.forEach(copy)
    }

    private func purgeMirror() {
        guard let mirror else { return isPurgePending = false }
        do {
            try mirror.removeAll()
            isPurgePending = false
            loaded.removeAll()
        } catch {
            report(error)
        }
    }

    /// The whole entry, so the mirror ends up with what the session has.
    private func copy(_ slug: EventSlug) {
        guard let mirror else { return }
        // Held back until "forget me" reaches the file, which would
        // otherwise delete it again.
        if isPurgePending {
            unsynced.insert(slug)
            return
        }
        let value = session.credentials(for: slug)
        // A change without a token (a private event's grant) never replaces
        // an entry this session couldn't read: it may hold the guest's token.
        if unreadable.contains(slug), value?.guestToken == nil {
            unsynced.remove(slug)
            return
        }
        do {
            if let value {
                try mirror.save(value, for: slug)
            } else {
                try mirror.removeCredentials(for: slug)
            }
            unsynced.remove(slug)
            unreadable.remove(slug)
            loaded.insert(slug)
        } catch {
            unsynced.insert(slug)
            report(error)
        }
    }

    private func report(_ error: any Error) {
        // Status only: never the entry, nor a path.
        log.error("handover copy failed: \(String(describing: type(of: error)), privacy: .public) \((error as NSError).code, privacy: .public)")
    }
}
