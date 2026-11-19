import CredentialStore
import Foundation
import Testing

private let session = StoredHostSession(token: "hs_secret_token", expiresAt: Date(timeIntervalSince1970: 2_000_000_000))

private func exercise(_ store: some HostSessionStore) throws {
    try store.remove()
    #expect(try store.load() == nil)
    try store.save(session)
    #expect(try store.load() == session)
    let newer = StoredHostSession(token: "hs_newer", expiresAt: session.expiresAt.addingTimeInterval(60))
    try store.save(newer)
    #expect(try store.load() == newer)
    try store.remove()
    #expect(try store.load() == nil)
    try store.remove()
}

@Suite struct HostSessionStoreTests {
    @Test func inMemory() throws { try exercise(InMemoryHostSessionStore()) }

    @Test(.enabled(if: isKeychainAvailable)) func keychain() throws {
        let store = KeychainHostSessionStore(service: "moments.tests.\(UUID().uuidString)")
        defer { try? store.remove() }
        try exercise(store)
    }

    @Test(.enabled(if: isKeychainAvailable)) func keptApartFromGuestCredentials() throws {
        let service = "moments.tests.\(UUID().uuidString)"
        let guests = KeychainEventCredentialStore(service: service)
        let host = KeychainHostSessionStore(service: service + ".host")
        defer { try? host.remove(); try? guests.removeAll() }
        try host.save(session)
        try guests.removeAll()
        #expect(try host.load() == session)
        #expect(KeychainHostSessionStore.defaultService != KeychainEventCredentialStore.defaultService)
    }

    @Test func expiry() {
        #expect(session.isLive(at: session.expiresAt.addingTimeInterval(-1)))
        #expect(!session.isLive(at: session.expiresAt))
    }

    @Test func neverPrintsTheToken() {
        #expect(!String(describing: session).contains("hs_secret"))
        #expect(!String(reflecting: session).contains("hs_secret"))
    }
}
