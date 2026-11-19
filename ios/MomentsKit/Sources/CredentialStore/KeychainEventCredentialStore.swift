import Foundation
import MomentsDomain
import Security

/// Keychain-backed store: one generic-password item per event slug, holding
/// the JSON of `StoredEventCredentials`.
///
/// - Accessibility `AfterFirstUnlockThisDeviceOnly`: background uploads need
///   the guest token while the phone is locked; `ThisDeviceOnly` keeps the
///   items out of backups that can be restored to another device. Items do
///   survive app deletion on iOS: see `CredentialLifecycle`.
/// - Never synchronised to iCloud Keychain.
/// - All operations go through one lock, so `update` is atomic in-process.
///   Sharing with the App Clip (`accessGroup`) will need cross-process care:
///   decide the group once and pass it on every call.
public final class KeychainEventCredentialStore: EventCredentialStore, @unchecked Sendable {
    // @unchecked: immutable configuration plus `lock`; SecItem calls are thread-safe.
    public enum KeychainError: Error, Equatable {
        case unexpectedStatus(OSStatus)
        /// The device is locked and has not been unlocked since boot.
        case unavailableWhileLocked
        case tooManyItems
    }

    public static let defaultService = "moments.event-credentials"

    private let service: String
    private let accessGroup: String?
    private let lock = NSLock()

    public init(service: String = KeychainEventCredentialStore.defaultService, accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    public func credentials(for slug: EventSlug) throws -> StoredEventCredentials? {
        try lock.withLock { try read(slug) }
    }

    public func save(_ credentials: StoredEventCredentials, for slug: EventSlug) throws {
        try lock.withLock { try write(credentials, slug) }
    }

    public func update(for slug: EventSlug, _ change: (inout StoredEventCredentials) -> Void) throws {
        try lock.withLock {
            let original = try read(slug) ?? StoredEventCredentials()
            var value = original
            change(&value)
            // Unchanged (including an unreadable item read as empty): no write,
            // so a lookup can never delete what it couldn't read.
            guard value != original else { return }
            try write(value, slug)
        }
    }

    public func removeCredentials(for slug: EventSlug) throws {
        try lock.withLock { try delete(baseQuery(slug: slug)) }
    }

    public func removeAll() throws {
        try lock.withLock {
            // iOS deletes every match at once; the macOS file keychain (used by
            // `swift test`) deletes one per call, so repeat until none are left.
            for _ in 0..<10_000 {
                let status = SecItemDelete(baseQuery() as CFDictionary)
                if status == errSecItemNotFound { return }
                try check(status)
            }
            throw KeychainError.tooManyItems
        }
    }

    public func storedSlugs() throws -> [EventSlug] {
        try lock.withLock {
            // Attributes only: the listing itself never reads the stored values.
            var query = baseQuery()
            query[kSecReturnAttributes as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitAll
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecItemNotFound { return [] }
            try check(status)
            let items = result as? [[String: Any]] ?? []
            // An account that isn't a valid slug isn't ours to show.
            let slugs = items.compactMap { ($0[kSecAttrAccount as String] as? String).flatMap(EventSlug.init) }
            return Set(slugs).sorted { $0.value < $1.value }
        }
    }

    // MARK: - Unlocked helpers (callers hold `lock`)

    private func baseQuery(slug: EventSlug? = nil) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
        if let slug { query[kSecAttrAccount as String] = slug.value }
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    /// Unreadable items read as nil and are overwritten by the next save;
    /// they are never deleted here, so a format change can't wipe a guest token.
    private func read(_ slug: EventSlug) throws -> StoredEventCredentials? {
        var query = baseQuery(slug: slug)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try check(status)
        return (result as? Data).flatMap(StoredEventCredentials.decode)
    }

    private func write(_ credentials: StoredEventCredentials, _ slug: EventSlug) throws {
        guard !credentials.isEmpty else { return try delete(baseQuery(slug: slug)) }
        let attributes: [String: Any] = [
            kSecValueData as String: try StoredEventCredentials.encode(credentials),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(baseQuery(slug: slug) as CFDictionary, attributes as CFDictionary)
        guard updateStatus == errSecItemNotFound else { return try check(updateStatus) }
        let addStatus = SecItemAdd(baseQuery(slug: slug).merging(attributes) { _, new in new } as CFDictionary, nil)
        // Another process added it between our update and add: update again.
        if addStatus == errSecDuplicateItem {
            return try check(SecItemUpdate(baseQuery(slug: slug) as CFDictionary, attributes as CFDictionary))
        }
        try check(addStatus)
    }

    private func delete(_ query: [String: Any]) throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status != errSecItemNotFound else { return }
        try check(status)
    }

    private func check(_ status: OSStatus) throws {
        switch status {
        case errSecSuccess: return
        case errSecInteractionNotAllowed: throw KeychainError.unavailableWhileLocked
        default: throw KeychainError.unexpectedStatus(status)
        }
    }
}
