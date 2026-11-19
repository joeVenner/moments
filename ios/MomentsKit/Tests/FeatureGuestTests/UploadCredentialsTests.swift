import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import FeatureGuest
import UploadEngine

struct UploadCredentialsTests {
    private struct LockedStore: EventCredentialStore {
        struct Locked: Error {}
        func credentials(for slug: EventSlug) throws -> StoredEventCredentials? { throw Locked() }
        func save(_ credentials: StoredEventCredentials, for slug: EventSlug) throws {}
        func update(for slug: EventSlug, _ change: (inout StoredEventCredentials) -> Void) throws {}
        func removeCredentials(for slug: EventSlug) throws {}
        func removeAll() throws {}
    }

    private func result(_ lookup: UploadQueue.CredentialsLookup, _ slug: String) async -> String {
        switch await lookup(slug) {
        case let .found(credentials): "found:\(credentials.guestToken ?? "-"):\(credentials.accessGrant ?? "-")"
        case .missing: "missing"
        case .unavailable: "unavailable"
        }
    }

    @Test func findsTheGuestTokenAndAValidGrant() async throws {
        let store = InMemoryEventCredentialStore()
        let slug = try #require(EventSlug("party"))
        store.save(
            StoredEventCredentials(accessGrant: "grant", accessGrantExpiresAt: Date().addingTimeInterval(3600), guestToken: "gt_a"),
            for: slug
        )
        #expect(await result(uploadCredentialsLookup(store: store), "party") == "found:gt_a:grant")
    }

    @Test func dropsAnExpiredGrantButKeepsTheToken() async throws {
        let store = InMemoryEventCredentialStore()
        store.save(
            StoredEventCredentials(accessGrant: "old", accessGrantExpiresAt: Date().addingTimeInterval(-10), guestToken: "gt_a"),
            for: try #require(EventSlug("party"))
        )
        #expect(await result(uploadCredentialsLookup(store: store), "party") == "found:gt_a:-")
    }

    @Test func needsAJoinWithoutAToken() async throws {
        let store = InMemoryEventCredentialStore()
        store.save(StoredEventCredentials(accessGrant: "grant"), for: try #require(EventSlug("party")))
        let lookup = uploadCredentialsLookup(store: store)
        #expect(await result(lookup, "party") == "missing")
        #expect(await result(lookup, "other") == "missing")
        #expect(await result(lookup, "not a slug!") == "missing")
    }

    @Test func waitsWhenTheStoreCantBeReadNow() async {
        #expect(await result(uploadCredentialsLookup(store: LockedStore()), "party") == "unavailable")
    }
}
