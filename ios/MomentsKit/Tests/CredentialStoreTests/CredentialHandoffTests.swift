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
    var failingRemovals: Set<EventSlug> = []
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
    func removeCredentials(for slug: EventSlug) throws {
        if failingRemovals.contains(slug) { throw StoreFailure() }
        inner.removeCredentials(for: slug)
    }
    func removeAll() throws { inner.removeAll() }
    func storedSlugs() throws -> [EventSlug] { inner.storedSlugs() }
}

private let fixedNow = Date(timeIntervalSince1970: 2_000_000_000)

/// What the app keeps: no handover stamp.
private func joined(_ token: String, nickname: String = "Lea") -> StoredEventCredentials {
    StoredEventCredentials(eventID: "e1", guestToken: token, participantID: "p1", nickname: nickname)
}

/// What the Clip saves: stamped `ago` seconds before `now`.
private func handed(_ token: String, nickname: String = "Lea", ago: TimeInterval = 60) -> StoredEventCredentials {
    var value = joined(token, nickname: nickname)
    value.handedOverAt = fixedNow.addingTimeInterval(-ago)
    return value
}

@Suite struct CredentialHandoffTests {
    @Test func movesTheClipsGuestIntoTheApp() throws {
        let shared = ScriptedStore([party: handed("gt_clip")])
        let own = ScriptedStore()
        #expect(try CredentialHandoff.importFromClip(shared, into: own, now: fixedNow) == [party])
        #expect(own.inner.credentials(for: party) == joined("gt_clip"))
        #expect(shared.inner.storedSlugs().isEmpty)
    }

    @Test func nothingHandedOverDoesNothing() throws {
        let own = ScriptedStore([party: joined("gt_app")])
        #expect(try CredentialHandoff.importFromClip(ScriptedStore(), into: own, now: fixedNow).isEmpty)
        #expect(own.inner.credentials(for: party) == joined("gt_app"))
    }

    @Test func theAppsOwnGuestWinsAndTheClipsCopyGoes() throws {
        let shared = ScriptedStore([party: handed("gt_clip", nickname: "Clip")])
        let own = ScriptedStore([party: joined("gt_app")])
        #expect(try CredentialHandoff.importFromClip(shared, into: own, now: fixedNow).isEmpty)
        #expect(own.inner.credentials(for: party) == joined("gt_app"))
        #expect(shared.inner.storedSlugs().isEmpty)
    }

    @Test func aTokenlessAppEntryIsNeitherMergedNorAllowedToDropTheClipsToken() throws {
        let grantOnly = StoredEventCredentials(eventID: "e1", accessGrant: "grant")
        let shared = ScriptedStore([party: handed("gt_clip")])
        let own = ScriptedStore([party: grantOnly])
        #expect(try CredentialHandoff.importFromClip(shared, into: own, now: fixedNow).isEmpty)
        #expect(own.inner.credentials(for: party) == grantOnly)
        #expect(shared.inner.credentials(for: party) == handed("gt_clip"))
    }

    @Test func aFailedSaveKeepsTheClipsCopyAndTriesTheOthers() throws {
        let shared = ScriptedStore([party: handed("gt_1"), wedding: handed("gt_2")])
        let own = ScriptedStore()
        own.failSaves = true
        #expect(throws: StoreFailure.self) { try CredentialHandoff.importFromClip(shared, into: own, now: fixedNow) }
        #expect(Set(shared.inner.storedSlugs()) == [party, wedding])
    }

    @Test func aSaveThatDidntStickKeepsTheClipsCopy() throws {
        let shared = ScriptedStore([party: handed("gt_clip")])
        let own = ScriptedStore()
        own.dropSaves = true
        #expect(try CredentialHandoff.importFromClip(shared, into: own, now: fixedNow).isEmpty)
        #expect(shared.inner.credentials(for: party) == handed("gt_clip"))
    }

    @Test func oneFailingEventDoesntStopTheRest() throws {
        let shared = ScriptedStore([party: handed("gt_1"), wedding: handed("gt_2")])
        let own = FailOnce(failing: party)
        #expect(throws: StoreFailure.self) { try CredentialHandoff.importFromClip(shared, into: own, now: fixedNow) }
        #expect(own.inner.credentials(for: wedding) == joined("gt_2"))
        #expect(shared.inner.storedSlugs() == [party])
    }

    @Test func unreadableOrTokenlessClipEntriesStay() throws {
        var tokenless = StoredEventCredentials(eventID: "e1", accessGrant: "grant", accessGrantExpiresAt: fixedNow.addingTimeInterval(3600))
        tokenless.handedOverAt = fixedNow
        let shared = ScriptedStore([party: handed("gt_clip"), wedding: tokenless])
        shared.unreadable = [party]
        let own = ScriptedStore()
        #expect(try CredentialHandoff.importFromClip(shared, into: own, now: fixedNow).isEmpty)
        #expect(own.inner.storedSlugs().isEmpty)
        #expect(Set(shared.inner.storedSlugs()) == [party, wedding])
    }
}

@Suite struct CredentialHandoffWindowTests {
    @Test(arguments: [
        (60.0, true),
        (CredentialHandoff.handoffWindow, true),
        (CredentialHandoff.handoffWindow + 1, false),
        // A clock set back: tolerated up to `futureTolerance`.
        (-CredentialHandoff.futureTolerance, true),
        (-CredentialHandoff.futureTolerance - 1, false),
    ])
    func importsOnlyRecentHandovers(_ ago: TimeInterval, _ isImported: Bool) throws {
        let shared = ScriptedStore([party: handed("gt_clip", ago: ago)])
        let own = ScriptedStore()
        #expect(try CredentialHandoff.importFromClip(shared, into: own, now: fixedNow) == (isImported ? [party] : []))
        #expect((own.inner.credentials(for: party) != nil) == isImported)
        // Imported or too old, the Clip's copy goes either way.
        #expect(shared.inner.storedSlugs().isEmpty)
    }

    @Test func anUnstampedEntryIsDeletedUnread() throws {
        let shared = ScriptedStore([party: joined("gt_clip")])
        let own = ScriptedStore()
        #expect(try CredentialHandoff.importFromClip(shared, into: own, now: fixedNow).isEmpty)
        #expect(own.inner.storedSlugs().isEmpty && shared.inner.storedSlugs().isEmpty)
    }

    @Test func anEntryWithoutAnEventStaysUntilItIsTooOld() throws {
        var noEvent = handed("gt_clip")
        noEvent.eventID = nil
        let shared = ScriptedStore([party: noEvent])
        let own = ScriptedStore()
        #expect(try CredentialHandoff.importFromClip(shared, into: own, now: fixedNow).isEmpty)
        #expect(own.inner.storedSlugs().isEmpty)
        #expect(shared.inner.credentials(for: party) == noEvent)
        let later = fixedNow.addingTimeInterval(CredentialHandoff.handoffWindow)
        #expect(try CredentialHandoff.importFromClip(shared, into: own, now: later).isEmpty)
        #expect(shared.inner.storedSlugs().isEmpty && own.inner.storedSlugs().isEmpty)
    }

    @Test func anOldTokenlessEntryIsDeletedToo() throws {
        var grantOnly = StoredEventCredentials(eventID: "e1", accessGrant: "grant")
        grantOnly.handedOverAt = fixedNow.addingTimeInterval(-CredentialHandoff.handoffWindow - 1)
        let shared = ScriptedStore([party: grantOnly])
        #expect(try CredentialHandoff.importFromClip(shared, into: ScriptedStore(), now: fixedNow).isEmpty)
        #expect(shared.inner.storedSlugs().isEmpty)
    }

    @Test func anUnreadableEntryStaysWhateverItsAge() throws {
        let shared = ScriptedStore([party: handed("gt_clip", ago: CredentialHandoff.handoffWindow * 10)])
        shared.unreadable = [party]
        #expect(try CredentialHandoff.importFromClip(shared, into: ScriptedStore(), now: fixedNow).isEmpty)
        #expect(shared.inner.storedSlugs() == [party])
    }

    @Test func aFailedDeleteOfAStaleEntryDoesntStopTheRest() throws {
        let shared = ScriptedStore([party: handed("gt_old", ago: CredentialHandoff.handoffWindow + 1), wedding: handed("gt_new")])
        shared.failingRemovals = [party]
        let own = ScriptedStore()
        #expect(throws: StoreFailure.self) { try CredentialHandoff.importFromClip(shared, into: own, now: fixedNow) }
        // The stale one wasn't imported (and stays for the next launch); the
        // recent one still moved.
        #expect(own.inner.storedSlugs() == [wedding])
        #expect(shared.inner.storedSlugs() == [party])
    }

    @Test func theAppsCopyHasNoStampAndOnlyALiveGrant() throws {
        var live = handed("gt_1")
        live.accessGrant = "grant_live"
        live.accessGrantExpiresAt = fixedNow.addingTimeInterval(3600)
        var expired = handed("gt_2")
        expired.accessGrant = "grant_old"
        expired.accessGrantExpiresAt = fixedNow.addingTimeInterval(-1)
        let own = ScriptedStore()
        try CredentialHandoff.importFromClip(ScriptedStore([party: live, wedding: expired]), into: own, now: fixedNow)
        let liveCopy = try #require(own.inner.credentials(for: party))
        #expect(liveCopy.handedOverAt == nil)
        #expect(liveCopy.accessGrant == "grant_live" && liveCopy.accessGrantExpiresAt == live.accessGrantExpiresAt)
        let expiredCopy = try #require(own.inner.credentials(for: wedding))
        #expect(expiredCopy.accessGrant == nil && expiredCopy.accessGrantExpiresAt == nil)
        #expect(expiredCopy.guestToken == "gt_2")
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
