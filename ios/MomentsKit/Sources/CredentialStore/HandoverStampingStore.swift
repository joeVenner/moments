import Foundation
import MomentsDomain

/// The App Clip's credential store: every write that changes an entry
/// stamps `handedOverAt`, so the app's import window (`CredentialHandoff`)
/// counts from the last change the Clip made (a join, a report, a mute),
/// whichever call made it. The app clears the stamp when it imports. Reads
/// and removals pass straight through.
///
/// Only the Clip's shared-group store goes through this; never wrap the
/// app's own store (its entries would keep a stamp nothing clears).
public struct HandoverStampingStore<Base: EventCredentialStore>: EventCredentialStore {
    private let base: Base
    private let now: @Sendable () -> Date

    public init(_ base: Base, now: @escaping @Sendable () -> Date = { Date() }) {
        self.base = base
        self.now = now
    }

    public func credentials(for slug: EventSlug) throws -> StoredEventCredentials? {
        try base.credentials(for: slug)
    }

    public func save(_ credentials: StoredEventCredentials, for slug: EventSlug) throws {
        var stamped = credentials
        stamped.handedOverAt = now()
        try base.save(stamped, for: slug)
    }

    public func update(for slug: EventSlug, _ change: (inout StoredEventCredentials) -> Void) throws {
        try base.update(for: slug) { value in
            let before = value
            change(&value)
            // A lookup that changes nothing stays a no-op (and creates nothing).
            if value != before { value.handedOverAt = now() }
        }
    }

    public func removeCredentials(for slug: EventSlug) throws { try base.removeCredentials(for: slug) }
    public func removeAll() throws { try base.removeAll() }
    public func storedSlugs() throws -> [EventSlug] { try base.storedSlugs() }
}
