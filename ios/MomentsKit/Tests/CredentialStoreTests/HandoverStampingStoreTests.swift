import CredentialStore
import Foundation
import MomentsDomain
import Testing

private let party = EventSlug("party")!
private let stampTime = Date(timeIntervalSince1970: 2_000_000_000)

@Suite struct HandoverStampingStoreTests {
    private func store(_ base: InMemoryEventCredentialStore) -> HandoverStampingStore<InMemoryEventCredentialStore> {
        HandoverStampingStore(base, now: { stampTime })
    }

    @Test func aJoinIsStamped() throws {
        let base = InMemoryEventCredentialStore()
        try store(base).save(StoredEventCredentials(eventID: "e1", guestToken: "gt"), for: party)
        #expect(base.credentials(for: party)?.handedOverAt == stampTime)
    }

    @Test func aChangeRefreshesTheStamp() throws {
        var old = StoredEventCredentials(eventID: "e1", guestToken: "gt")
        old.handedOverAt = .distantPast
        let base = InMemoryEventCredentialStore([party: old])
        try store(base).update(for: party) { $0.rememberReport(of: "m1") }
        #expect(base.credentials(for: party)?.handedOverAt == stampTime)
        #expect(base.credentials(for: party)?.reportedMomentIDs == ["m1"])
    }

    @Test func anUpdateThatChangesNothingLeavesTheStamp() throws {
        var old = StoredEventCredentials(eventID: "e1", guestToken: "gt")
        old.handedOverAt = .distantPast
        old.rememberReport(of: "m1")
        let base = InMemoryEventCredentialStore([party: old])
        try store(base).update(for: party) { $0.rememberReport(of: "m1") }
        #expect(base.credentials(for: party)?.handedOverAt == .distantPast)
        // Nothing stored: a no-op stays a no-op.
        try store(base).update(for: EventSlug("wedding")!) { _ in }
        #expect(base.storedSlugs() == [party])
    }

    @Test func aChangeToANewEntryIsStamped() throws {
        let base = InMemoryEventCredentialStore()
        try store(base).update(for: party) { $0.accessGrant = "grant" }
        #expect(base.credentials(for: party)?.handedOverAt == stampTime)
    }

    @Test func savingNothingLeavesNothing() throws {
        let base = InMemoryEventCredentialStore([party: StoredEventCredentials(eventID: "e1", guestToken: "gt")])
        try store(base).save(StoredEventCredentials(eventID: "e1"), for: party)
        #expect(base.storedSlugs().isEmpty)
    }

    @Test func failuresReachTheCaller() {
        let clip = HandoverStampingStore(BrokenStore(), now: { stampTime })
        #expect(throws: BrokenStore.Failure.self) { try clip.save(StoredEventCredentials(guestToken: "gt"), for: party) }
        #expect(throws: BrokenStore.Failure.self) { try clip.update(for: party) { $0.guestToken = "gt" } }
    }

    @Test func readsAndRemovalsPassThrough() throws {
        let base = InMemoryEventCredentialStore([party: StoredEventCredentials(eventID: "e1", guestToken: "gt")])
        let clip = store(base)
        #expect(try clip.credentials(for: party)?.guestToken == "gt")
        #expect(try clip.storedSlugs() == [party])
        try clip.removeCredentials(for: party)
        #expect(base.storedSlugs().isEmpty)
        base.save(StoredEventCredentials(guestToken: "gt"), for: party)
        try clip.removeAll()
        #expect(base.storedSlugs().isEmpty)
    }

}

private struct BrokenStore: EventCredentialStore {
    struct Failure: Error {}
    func credentials(for slug: EventSlug) throws -> StoredEventCredentials? { throw Failure() }
    func save(_ credentials: StoredEventCredentials, for slug: EventSlug) throws { throw Failure() }
    func update(for slug: EventSlug, _ change: (inout StoredEventCredentials) -> Void) throws { throw Failure() }
    func removeCredentials(for slug: EventSlug) throws { throw Failure() }
    func removeAll() throws { throw Failure() }
    func storedSlugs() throws -> [EventSlug] { throw Failure() }
}
