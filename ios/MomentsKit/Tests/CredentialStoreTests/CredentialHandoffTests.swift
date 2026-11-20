import CredentialStore
import Foundation
import MomentsDomain
import Testing

private let party = EventSlug("party")!
private let wedding = EventSlug("wedding")!

private struct StoreFailure: Error, Equatable {}

/// Wraps an in-memory store; saves (or reads of one slug) can be made to fail.
private final class ScriptedStore: EventCredentialStore, @unchecked Sendable {
    let inner: InMemoryEventCredentialStore
    var failSaves = false
    var dropSaves = false
    var unreadable: Set<EventSlug> = []

    init(_ entries: [EventSlug: StoredEventCredentials] = [:]) { inner = InMemoryEventCredentialStore(entries) }

    func credentials(for slug: EventSlug) throws -> StoredEventCredentials? {
        if unreadable.contains(slug) { return nil }
        return inner.credentials(for: slug)
    }
    func save(_ credentials: StoredEventCredentials, for slug: EventSlug) throws {
        if failSaves { throw StoreFailure() }
        if dropSaves { return }
        inner.save(credentials, for: slug)
    }
    func update(for slug: EventSlug, _ change: (inout StoredEventCredentials) -> Void) throws { inner.update(for: slug, change) }
    func removeCredentials(for slug: EventSlug) throws { inner.removeCredentials(for: slug) }
    func removeAll() throws { inner.removeAll() }
    func storedSlugs() throws -> [EventSlug] { inner.storedSlugs() }
}

private func joined(_ token: String, nickname: String = "Lea") -> StoredEventCredentials {
    StoredEventCredentials(eventID: "e1", guestToken: token, participantID: "p1", nickname: nickname)
}

@Suite struct CredentialHandoffTests {
    @Test func movesTheClipsGuestIntoTheApp() throws {
        let shared = ScriptedStore([party: joined("gt_clip")])
        let own = ScriptedStore()
        #expect(try CredentialHandoff.importFromClip(shared, into: own) == [party])
        #expect(own.inner.credentials(for: party) == joined("gt_clip"))
        #expect(shared.inner.storedSlugs().isEmpty)
    }

    @Test func nothingHandedOverDoesNothing() throws {
        let own = ScriptedStore([party: joined("gt_app")])
        #expect(try CredentialHandoff.importFromClip(ScriptedStore(), into: own).isEmpty)
        #expect(own.inner.credentials(for: party) == joined("gt_app"))
    }

    @Test func theAppsOwnGuestWinsAndTheClipsCopyGoes() throws {
        let shared = ScriptedStore([party: joined("gt_clip", nickname: "Clip")])
        let own = ScriptedStore([party: joined("gt_app")])
        #expect(try CredentialHandoff.importFromClip(shared, into: own).isEmpty)
        #expect(own.inner.credentials(for: party) == joined("gt_app"))
        #expect(shared.inner.storedSlugs().isEmpty)
    }

    @Test func aTokenlessAppEntryIsNeitherMergedNorAllowedToDropTheClipsToken() throws {
        let grantOnly = StoredEventCredentials(eventID: "e1", accessGrant: "grant")
        let shared = ScriptedStore([party: joined("gt_clip")])
        let own = ScriptedStore([party: grantOnly])
        #expect(try CredentialHandoff.importFromClip(shared, into: own).isEmpty)
        #expect(own.inner.credentials(for: party) == grantOnly)
        #expect(shared.inner.credentials(for: party) == joined("gt_clip"))
    }

    @Test func aFailedSaveKeepsTheClipsCopyAndTriesTheOthers() throws {
        let shared = ScriptedStore([party: joined("gt_1"), wedding: joined("gt_2")])
        let own = ScriptedStore()
        own.failSaves = true
        #expect(throws: StoreFailure.self) { try CredentialHandoff.importFromClip(shared, into: own) }
        #expect(Set(shared.inner.storedSlugs()) == [party, wedding])
    }

    @Test func aSaveThatDidntStickKeepsTheClipsCopy() throws {
        let shared = ScriptedStore([party: joined("gt_clip")])
        let own = ScriptedStore()
        own.dropSaves = true
        #expect(try CredentialHandoff.importFromClip(shared, into: own).isEmpty)
        #expect(shared.inner.credentials(for: party) == joined("gt_clip"))
    }

    @Test func oneFailingEventDoesntStopTheRest() throws {
        let shared = ScriptedStore([party: joined("gt_1"), wedding: joined("gt_2")])
        let own = FailOnce(failing: party)
        #expect(throws: StoreFailure.self) { try CredentialHandoff.importFromClip(shared, into: own) }
        #expect(own.inner.credentials(for: wedding) == joined("gt_2"))
        #expect(shared.inner.storedSlugs() == [party])
    }

    @Test func unreadableOrTokenlessClipEntriesStay() throws {
        let shared = ScriptedStore([party: joined("gt_clip"), wedding: StoredEventCredentials(accessGrant: "grant")])
        shared.unreadable = [party]
        let own = ScriptedStore()
        #expect(try CredentialHandoff.importFromClip(shared, into: own).isEmpty)
        #expect(own.inner.storedSlugs().isEmpty)
        #expect(Set(shared.inner.storedSlugs()) == [party, wedding])
    }
}

/// Fails the save for one slug only.
private final class FailOnce: EventCredentialStore, @unchecked Sendable {
    let inner = InMemoryEventCredentialStore()
    let failing: EventSlug
    init(failing: EventSlug) { self.failing = failing }
    func credentials(for slug: EventSlug) throws -> StoredEventCredentials? { inner.credentials(for: slug) }
    func save(_ credentials: StoredEventCredentials, for slug: EventSlug) throws {
        if slug == failing { throw StoreFailure() }
        inner.save(credentials, for: slug)
    }
    func update(for slug: EventSlug, _ change: (inout StoredEventCredentials) -> Void) throws { inner.update(for: slug, change) }
    func removeCredentials(for slug: EventSlug) throws { inner.removeCredentials(for: slug) }
    func removeAll() throws { inner.removeAll() }
    func storedSlugs() throws -> [EventSlug] { inner.storedSlugs() }
}
