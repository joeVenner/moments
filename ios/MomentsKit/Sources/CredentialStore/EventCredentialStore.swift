import Foundation
import MomentsDomain

/// What this device holds for one event: the private-event grant, the guest
/// token that owns its nickname, and who it joined as.
public struct StoredEventCredentials: Sendable, Hashable, Codable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    /// Bumped when the stored shape changes incompatibly.
    public static let currentSchemaVersion = 1

    public var schemaVersion: Int
    /// The event these belong to, once known (the grant is fetched before the
    /// event, so it can be nil at first). Slugs of purged events can be
    /// reused, so a different ID means the entry is stale.
    public var eventID: String?
    public var accessGrant: String?
    public var accessGrantExpiresAt: Date?
    public var guestToken: String?
    /// Not a secret; kept with the token it belongs to.
    public var participantID: String?

    public init(
        eventID: String? = nil, accessGrant: String? = nil, accessGrantExpiresAt: Date? = nil,
        guestToken: String? = nil, participantID: String? = nil
    ) {
        schemaVersion = Self.currentSchemaVersion
        self.eventID = eventID
        self.accessGrant = accessGrant
        self.accessGrantExpiresAt = accessGrantExpiresAt
        self.guestToken = guestToken
        self.participantID = participantID
    }

    /// The grant if it is still valid at `now` (with a minute's margin for clock skew).
    public func validAccessGrant(at now: Date = .now) -> String? {
        guard let accessGrant, let accessGrantExpiresAt, accessGrantExpiresAt > now.addingTimeInterval(60) else { return nil }
        return accessGrant
    }

    /// Nothing worth keeping (an event ID alone is not).
    public var isEmpty: Bool {
        accessGrant == nil && accessGrantExpiresAt == nil && guestToken == nil && participantID == nil
    }

    // Redacted so secrets never reach logs or crash reports.
    public var description: String {
        "StoredEventCredentials(grant: \(accessGrant == nil ? "none" : "set"), guestToken: \(guestToken == nil ? "none" : "set"))"
    }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [:]) }

    /// Stable on-disk encoding (dates as seconds since 1970).
    static func encode(_ value: StoredEventCredentials) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        return try encoder.encode(value)
    }

    /// Nil for anything unreadable or written by a newer, incompatible build.
    static func decode(_ data: Data) -> StoredEventCredentials? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        guard let value = try? decoder.decode(StoredEventCredentials.self, from: data),
              value.schemaVersion <= currentSchemaVersion
        else { return nil }
        return value
    }
}

/// Per-event credential storage, keyed by slug. Implementations serialise
/// their own operations, so `update` is atomic within the process.
public protocol EventCredentialStore: Sendable {
    /// Nil when nothing usable is stored (missing or unreadable).
    func credentials(for slug: EventSlug) throws -> StoredEventCredentials?
    /// Saving an empty value removes the entry.
    func save(_ credentials: StoredEventCredentials, for slug: EventSlug) throws
    /// Atomic read-modify-write for one event; writes nothing when the value
    /// is unchanged.
    func update(for slug: EventSlug, _ change: (inout StoredEventCredentials) -> Void) throws
    func removeCredentials(for slug: EventSlug) throws
    /// "Forget me on this device" for every event.
    func removeAll() throws
}

public extension EventCredentialStore {
    /// Credentials for the event the server just returned. An entry recorded
    /// for a different event ID (the slug was reused) is deleted, and an entry
    /// without an ID adopts this one.
    func credentials(for slug: EventSlug, eventID: String) throws -> StoredEventCredentials? {
        var result: StoredEventCredentials?
        try update(for: slug) { stored in
            if let storedID = stored.eventID, storedID != eventID {
                stored = StoredEventCredentials()
            } else if !stored.isEmpty {
                stored.eventID = eventID
            }
            result = stored.isEmpty ? nil : stored
        }
        return result
    }
}

/// For tests and previews.
public final class InMemoryEventCredentialStore: EventCredentialStore, @unchecked Sendable {
    // @unchecked: all state is behind `lock` (Mutex needs iOS 18).
    private let lock = NSLock()
    private var entries: [EventSlug: StoredEventCredentials] = [:]

    public init(_ entries: [EventSlug: StoredEventCredentials] = [:]) {
        self.entries = entries
    }

    public func credentials(for slug: EventSlug) -> StoredEventCredentials? {
        lock.withLock { entries[slug] }
    }

    public func save(_ credentials: StoredEventCredentials, for slug: EventSlug) {
        lock.withLock { entries[slug] = credentials.isEmpty ? nil : credentials }
    }

    public func update(for slug: EventSlug, _ change: (inout StoredEventCredentials) -> Void) {
        lock.withLock {
            let original = entries[slug] ?? StoredEventCredentials()
            var value = original
            change(&value)
            guard value != original else { return }
            entries[slug] = value.isEmpty ? nil : value
        }
    }

    public func removeCredentials(for slug: EventSlug) {
        lock.withLock { entries[slug] = nil }
    }

    public func removeAll() {
        lock.withLock { entries.removeAll() }
    }
}

/// iOS keeps keychain items after the app is deleted. On the first launch of
/// a fresh install (no marker in the app's own defaults, which are deleted
/// with it) the store is wiped, so a reinstall or a handed-on phone starts clean.
public enum CredentialLifecycle {
    static let installMarkerKey = "moments.credentials.installed"

    public static func resetIfFreshInstall(_ store: some EventCredentialStore, defaults: UserDefaults = .standard) throws {
        guard !defaults.bool(forKey: installMarkerKey) else { return }
        try store.removeAll()
        defaults.set(true, forKey: installMarkerKey)
    }
}
