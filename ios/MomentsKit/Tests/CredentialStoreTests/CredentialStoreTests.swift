import Foundation
import MomentsDomain
import Security
import Testing
@testable import CredentialStore

let sampleCredentials = StoredEventCredentials(
    accessGrant: "grant-secret", accessGrantExpiresAt: Date(timeIntervalSince1970: 2_000_000_000),
    guestToken: "gt_secret", participantID: "p1"
)
private let party = EventSlug("party")!
private let other = EventSlug("other")!

/// Behaviour every store must share.
func exerciseStore(_ store: some EventCredentialStore) throws {
    try store.removeAll()
    #expect(try store.credentials(for: party) == nil)
    try store.save(sampleCredentials, for: party)
    #expect(try store.credentials(for: party) == sampleCredentials)

    try store.update(for: party) { $0.accessGrant = "grant-2" }
    #expect(try store.credentials(for: party)?.accessGrant == "grant-2")
    #expect(try store.credentials(for: party)?.guestToken == "gt_secret")

    try store.save(sampleCredentials, for: other)
    try store.removeCredentials(for: party)
    #expect(try store.credentials(for: party) == nil)
    #expect(try store.credentials(for: other) != nil)

    try store.save(StoredEventCredentials(eventID: "e1"), for: other)
    #expect(try store.credentials(for: other) == nil)

    try store.save(sampleCredentials, for: EventSlug("a")!)
    try store.save(sampleCredentials, for: EventSlug("b")!)
    try store.removeAll()
    #expect(try store.credentials(for: EventSlug("a")!) == nil && store.credentials(for: EventSlug("b")!) == nil)
    try store.removeCredentials(for: EventSlug("missing")!)
}

/// Slug reuse: an entry for another event ID is dropped; an ID-less one adopts it.
func exerciseEventIDBinding(_ store: some EventCredentialStore) throws {
    try store.removeAll()
    try store.save(sampleCredentials, for: party)
    #expect(try store.credentials(for: party, eventID: "e1")?.guestToken == "gt_secret")
    #expect(try store.credentials(for: party)?.eventID == "e1")
    #expect(try store.credentials(for: party, eventID: "e1") != nil)
    #expect(try store.credentials(for: party, eventID: "e2") == nil)
    #expect(try store.credentials(for: party) == nil)
}

/// Concurrent updates to different fields must not lose either write.
func exerciseConcurrentUpdates(_ store: some EventCredentialStore) async throws {
    try store.removeAll()
    try await withThrowingTaskGroup(of: Void.self) { group in
        for index in 0..<20 {
            group.addTask {
                try store.update(for: party) { value in
                    if index.isMultiple(of: 2) { value.accessGrant = "g\(index)" } else { value.participantID = "p\(index)" }
                    value.guestToken = (value.guestToken ?? "") + "x"
                }
            }
        }
        try await group.waitForAll()
    }
    #expect(try store.credentials(for: party)?.guestToken?.count == 20)
}

/// The keychain needs a process with keychain access; skip where absent.
let isKeychainAvailable: Bool = {
    let probe = KeychainEventCredentialStore(service: "moments.tests.probe")
    defer { try? probe.removeAll() }
    return (try? probe.save(sampleCredentials, for: EventSlug("probe")!)) != nil
}()

/// Listing returns every stored slug, sorted, and forgets removed ones.
func exerciseListing(_ store: some EventCredentialStore) throws {
    try store.removeAll()
    #expect(try store.storedSlugs().isEmpty)
    try store.save(sampleCredentials, for: party)
    try store.save(sampleCredentials, for: other)
    #expect(try store.storedSlugs() == [other, party])
    try store.removeCredentials(for: other)
    #expect(try store.storedSlugs() == [party])
}

@Suite struct CredentialStoreTests {
    @Test func inMemoryListing() throws {
        try exerciseListing(InMemoryEventCredentialStore())
    }

    @Test(.enabled(if: isKeychainAvailable)) func keychainListing() throws {
        let store = KeychainEventCredentialStore(service: "moments.tests.\(UUID().uuidString)")
        defer { try? store.removeAll() }
        try exerciseListing(store)
        // Another service's items never show up.
        let neighbour = KeychainEventCredentialStore(service: "moments.tests.\(UUID().uuidString)")
        defer { try? neighbour.removeAll() }
        try neighbour.save(sampleCredentials, for: other)
        #expect(try store.storedSlugs() == [party])
    }

    @Test func inMemoryStore() async throws {
        let store = InMemoryEventCredentialStore()
        try exerciseStore(store)
        try exerciseEventIDBinding(store)
        try await exerciseConcurrentUpdates(store)
    }

    @Test(.enabled(if: isKeychainAvailable)) func keychainStore() async throws {
        let store = KeychainEventCredentialStore(service: "moments.tests.\(UUID().uuidString)")
        defer { try? store.removeAll() }
        try exerciseStore(store)
        try exerciseEventIDBinding(store)
        try await exerciseConcurrentUpdates(store)
    }

    @Test(.enabled(if: isKeychainAvailable)) func corruptItemsReadAsNilAndAreOverwritten() throws {
        let service = "moments.tests.\(UUID().uuidString)"
        let store = KeychainEventCredentialStore(service: service)
        defer { try? store.removeAll() }
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: "party", kSecValueData as String: Data("not json".utf8),
        ]
        #expect(SecItemAdd(add as CFDictionary, nil) == errSecSuccess)
        #expect(try store.credentials(for: party) == nil)
        // A lookup by event ID must not delete what it couldn't read.
        #expect(try store.credentials(for: party, eventID: "e1") == nil)
        try store.update(for: party) { _ in }
        var query = add
        query.removeValue(forKey: kSecValueData as String)
        #expect(SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess)
        try store.save(sampleCredentials, for: party)
        #expect(try store.credentials(for: party) == sampleCredentials)
    }

    @Test(.enabled(if: isKeychainAvailable)) func keychainServicesAreIsolated() throws {
        let first = KeychainEventCredentialStore(service: "moments.tests.\(UUID().uuidString)")
        let second = KeychainEventCredentialStore(service: "moments.tests.\(UUID().uuidString)")
        defer { try? first.removeAll(); try? second.removeAll() }
        try first.save(sampleCredentials, for: party)
        #expect(try second.credentials(for: party) == nil)
        try second.removeAll()
        #expect(try first.credentials(for: party) == sampleCredentials)
    }

    @Test func encodingIsStableAndVersioned() throws {
        let data = try StoredEventCredentials.encode(sampleCredentials)
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["schemaVersion"] as? Int == 1)
        #expect(json["accessGrantExpiresAt"] as? Double == 2_000_000_000)
        #expect(StoredEventCredentials.decode(data) == sampleCredentials)
        let newer = Data(#"{"schemaVersion":2,"guestToken":"x"}"#.utf8)
        #expect(StoredEventCredentials.decode(newer) == nil)
        let partial = Data(#"{"schemaVersion":1,"guestToken":"x"}"#.utf8)
        #expect(StoredEventCredentials.decode(partial)?.guestToken == "x")
    }

    @Test func freshInstallWipesTheStoreOnce() throws {
        let suite = "moments.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = InMemoryEventCredentialStore([party: sampleCredentials])
        try CredentialLifecycle.resetIfFreshInstall(store, defaults: defaults)
        #expect(store.credentials(for: party) == nil)
        store.save(sampleCredentials, for: party)
        try CredentialLifecycle.resetIfFreshInstall(store, defaults: defaults)
        #expect(store.credentials(for: party) == sampleCredentials)
    }

    @Test func grantExpiryHasAMargin() {
        let now = Date(timeIntervalSince1970: 1_000)
        var credentials = StoredEventCredentials(accessGrant: "g", accessGrantExpiresAt: now.addingTimeInterval(120))
        #expect(credentials.validAccessGrant(at: now) == "g")
        credentials.accessGrantExpiresAt = now.addingTimeInterval(30)
        #expect(credentials.validAccessGrant(at: now) == nil)
        credentials.accessGrantExpiresAt = nil
        #expect(credentials.validAccessGrant(at: now) == nil)
    }

    @Test func emptinessCountsEveryStoredField() {
        #expect(StoredEventCredentials(eventID: "e1").isEmpty)
        #expect(!StoredEventCredentials(accessGrantExpiresAt: .now).isEmpty)
    }

    @Test func secretsNeverAppearInDescriptions() {
        var dumped = ""
        dump(sampleCredentials, to: &dumped)
        for text in [String(describing: sampleCredentials), String(reflecting: sampleCredentials), "\(sampleCredentials)", dumped] {
            #expect(!text.contains("grant-secret") && !text.contains("gt_secret"), "\(text)")
        }
    }
}
