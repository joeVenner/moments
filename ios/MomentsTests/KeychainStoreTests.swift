import CredentialStore
import Foundation
import MomentsDomain
import Security
import Testing

/// Runs inside the app host so it exercises the real iOS keychain (bare
/// package tests have no keychain access on the simulator).
@Suite struct KeychainStoreTests {
    private let sample = StoredEventCredentials(
        accessGrant: "grant-secret", accessGrantExpiresAt: Date(timeIntervalSince1970: 2_000_000_000),
        guestToken: "gt_secret", participantID: "p1"
    )
    private let party = EventSlug("party")!

    @Test func roundTripsBindsAndRemoves() throws {
        let store = KeychainEventCredentialStore(service: "moments.tests.\(UUID().uuidString)")
        defer { try? store.removeAll() }
        try store.save(sample, for: party)
        #expect(try store.credentials(for: party) == sample)
        try store.update(for: party) { $0.accessGrant = nil; $0.accessGrantExpiresAt = nil }
        #expect(try store.credentials(for: party)?.guestToken == "gt_secret")
        #expect(try store.credentials(for: party, eventID: "e1") != nil)
        #expect(try store.credentials(for: party, eventID: "e2") == nil)
        try store.save(sample, for: EventSlug("other")!)
        try store.removeAll()
        #expect(try store.credentials(for: EventSlug("other")!) == nil)
    }

    @Test func itemsAreDeviceOnlyAndNeverSynced() throws {
        let service = "moments.tests.\(UUID().uuidString)"
        let store = KeychainEventCredentialStore(service: service)
        defer { try? store.removeAll() }
        try store.save(sample, for: party)
        // Match synced and unsynced items alike, so a synced copy can't hide.
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var result: CFTypeRef?
        #expect(SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess)
        let items = try #require(result as? [[String: Any]])
        #expect(items.count == 1)
        for attributes in items {
            #expect(attributes[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
            #expect((attributes[kSecAttrSynchronizable as String] as? NSNumber)?.boolValue != true)
        }
    }
}
