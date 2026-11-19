import Foundation
import Security

/// The signed-in host's session token, as kept on this device.
public struct StoredHostSession: Sendable, Hashable, Codable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let token: String
    public let expiresAt: Date

    public init(token: String, expiresAt: Date) {
        self.token = token
        self.expiresAt = expiresAt
    }

    public func isLive(at now: Date) -> Bool { expiresAt > now }

    // Redacted so the token never reaches logs, crash reports or test output.
    public var description: String { "StoredHostSession(redacted, expiresAt: \(expiresAt))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// One host session per device (the admin login for now).
public protocol HostSessionStore: Sendable {
    /// Nil when signed out, or when the stored item can't be read.
    func load() throws -> StoredHostSession?
    func save(_ session: StoredHostSession) throws
    func remove() throws
}

/// For tests and previews.
public final class InMemoryHostSessionStore: HostSessionStore, @unchecked Sendable {
    // @unchecked: all state behind `lock`.
    private let lock = NSLock()
    private var session: StoredHostSession?

    public init(_ session: StoredHostSession? = nil) { self.session = session }

    public func load() -> StoredHostSession? { lock.withLock { session } }
    public func save(_ session: StoredHostSession) { lock.withLock { self.session = session } }
    public func remove() { lock.withLock { session = nil } }
}

/// Keychain-backed: one generic-password item in its own service, apart from
/// the guests' event credentials, so clearing one never touches the other.
///
/// - Accessibility `WhenUnlockedThisDeviceOnly`: host screens only run in the
///   foreground, so the token is unreadable while the phone is locked, and it
///   never goes into a backup restorable on another device.
/// - Never synchronised to iCloud Keychain; no access group (not shared with
///   the App Clip).
public final class KeychainHostSessionStore: HostSessionStore, @unchecked Sendable {
    // @unchecked: immutable configuration plus `lock`; SecItem calls are thread-safe.
    public static let defaultService = "moments.host-session"
    static let account = "host"

    private let service: String
    private let lock = NSLock()

    public init(service: String = KeychainHostSessionStore.defaultService) {
        self.service = service
    }

    public func load() throws -> StoredHostSession? {
        try lock.withLock {
            var query = baseQuery()
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecItemNotFound { return nil }
            try KeychainSupport.check(status)
            // An unreadable item reads as signed out; the next sign-in overwrites it.
            return (result as? Data).flatMap { try? Self.decoder.decode(StoredHostSession.self, from: $0) }
        }
    }

    public func save(_ session: StoredHostSession) throws {
        try lock.withLock {
            let attributes: [String: Any] = [
                kSecValueData as String: try Self.encoder.encode(session),
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            ]
            try KeychainSupport.upsert(baseQuery(), attributes)
        }
    }

    public func remove() throws {
        try lock.withLock { try KeychainSupport.delete(baseQuery()) }
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return decoder
    }()
}
