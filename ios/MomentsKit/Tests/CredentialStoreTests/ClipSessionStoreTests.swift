import Foundation
import MomentsDomain
import Testing
@testable import CredentialStore

private let party = EventSlug("party")!
private let stampTime = Date(timeIntervalSince1970: 2_000_000_000)

/// Throws on everything: a locked phone, a damaged file.
private struct FailingStore: EventCredentialStore {
    struct Failure: Error {}
    func credentials(for slug: EventSlug) throws -> StoredEventCredentials? { throw Failure() }
    func save(_ credentials: StoredEventCredentials, for slug: EventSlug) throws { throw Failure() }
    func update(for slug: EventSlug, _ change: (inout StoredEventCredentials) -> Void) throws { throw Failure() }
    func removeCredentials(for slug: EventSlug) throws { throw Failure() }
    func removeAll() throws { throw Failure() }
    func storedSlugs() throws -> [EventSlug] { throw Failure() }
}

/// Counts writes reaching the mirror.
private final class CountingStore: EventCredentialStore, @unchecked Sendable {
    let inner = InMemoryEventCredentialStore()
    private(set) var writes = 0
    func credentials(for slug: EventSlug) -> StoredEventCredentials? { inner.credentials(for: slug) }
    func save(_ credentials: StoredEventCredentials, for slug: EventSlug) { writes += 1; inner.save(credentials, for: slug) }
    func update(for slug: EventSlug, _ change: (inout StoredEventCredentials) -> Void) { writes += 1; inner.update(for: slug, change) }
    func removeCredentials(for slug: EventSlug) { writes += 1; inner.removeCredentials(for: slug) }
    func removeAll() { writes += 1; inner.removeAll() }
    func storedSlugs() -> [EventSlug] { inner.storedSlugs() }
}

/// A mirror whose reads, writes or "forget me" fail on demand.
private final class FlakyStore: EventCredentialStore, @unchecked Sendable {
    struct Failure: Error {}
    let inner = InMemoryEventCredentialStore()
    var failsReads = false
    var failsWrites = false
    var failsRemoveAll = false
    func credentials(for slug: EventSlug) throws -> StoredEventCredentials? {
        if failsReads { throw Failure() }
        return inner.credentials(for: slug)
    }
    func save(_ credentials: StoredEventCredentials, for slug: EventSlug) throws {
        if failsWrites { throw Failure() }
        inner.save(credentials, for: slug)
    }
    func update(for slug: EventSlug, _ change: (inout StoredEventCredentials) -> Void) throws {
        if failsWrites { throw Failure() }
        inner.update(for: slug, change)
    }
    func removeCredentials(for slug: EventSlug) throws {
        if failsWrites { throw Failure() }
        inner.removeCredentials(for: slug)
    }
    func removeAll() throws {
        if failsRemoveAll { throw Failure() }
        inner.removeAll()
    }
    func storedSlugs() throws -> [EventSlug] {
        if failsReads { throw Failure() }
        return inner.storedSlugs()
    }
}

private let other = EventSlug("other")!

@Suite struct ClipSessionStoreTests {
    private let directory = FileManager.default.temporaryDirectory
        .appending(path: "moments-clip-session-\(UUID().uuidString)", directoryHint: .isDirectory)

    private func handover() -> HandoverStampingStore<FileEventCredentialStore> {
        HandoverStampingStore(FileEventCredentialStore(directory: directory), now: { stampTime })
    }

    private var joined: StoredEventCredentials {
        StoredEventCredentials(eventID: "e1", guestToken: "gt_clip", participantID: "p1", nickname: "Lea")
    }

    @Test func behavesLikeEveryStoreWithAndWithoutAMirror() async throws {
        defer { try? FileManager.default.removeItem(at: directory) }
        for mirror in [nil, handover() as (any EventCredentialStore)?] {
            try exerciseStore(ClipSessionStore(mirror: mirror))
            try exerciseEventIDBinding(ClipSessionStore(mirror: mirror))
            try await exerciseConcurrentUpdates(ClipSessionStore(mirror: mirror))
        }
    }

    @Test func aJoinReachesTheHandoverFileStamped() throws {
        defer { try? FileManager.default.removeItem(at: directory) }
        ClipSessionStore(mirror: handover()).save(joined, for: party)
        var expected = joined
        expected.handedOverAt = stampTime
        #expect(try FileEventCredentialStore(directory: directory).credentials(for: party) == expected)
    }

    @Test func aRelaunchedClipRemembersItsGuest() throws {
        defer { try? FileManager.default.removeItem(at: directory) }
        ClipSessionStore(mirror: handover()).save(joined, for: party)
        // Listing first: it reads the file too.
        #expect(ClipSessionStore(mirror: handover()).storedSlugs() == [party])
        let relaunched = ClipSessionStore(mirror: handover())
        #expect(relaunched.credentials(for: party)?.guestToken == "gt_clip")
        // A report keeps the guest, in the session and the file.
        relaunched.update(for: party) { $0.rememberReport(of: "m1") }
        #expect(try FileEventCredentialStore(directory: directory).credentials(for: party)?.guestToken == "gt_clip")
        #expect(try FileEventCredentialStore(directory: directory).credentials(for: party)?.reportedMomentIDs == ["m1"])
        relaunched.removeCredentials(for: party)
        #expect(try FileEventCredentialStore(directory: directory).storedSlugs().isEmpty)
    }

    @Test func aFailingHandoverNeverStopsTheGuest() {
        let store = ClipSessionStore(mirror: FailingStore())
        #expect(store.credentials(for: party) == nil)
        store.save(joined, for: party)
        store.update(for: party) { $0.mute(participantID: "p2") }
        #expect(store.credentials(for: party)?.guestToken == "gt_clip")
        #expect(store.credentials(for: party)?.mutedParticipantIDs == ["p2"])
        #expect(store.storedSlugs() == [party])
        store.removeAll()
        #expect(store.credentials(for: party) == nil)
    }

    @Test func aChangeThatChangesNothingIsntCopied() {
        let mirror = CountingStore()
        let store = ClipSessionStore(mirror: mirror)
        store.save(joined, for: party)
        #expect(mirror.writes == 1)
        store.update(for: party) { _ in }
        _ = try? store.credentials(for: party, eventID: "e1")
        #expect(mirror.writes == 1)
    }

    @Test func aGuestWhoLeftNeverComesBackFromAStaleFile() {
        let mirror = FlakyStore()
        mirror.inner.save(joined, for: party)
        mirror.failsRemoveAll = true
        let store = ClipSessionStore(mirror: mirror)
        store.removeAll()
        #expect(store.credentials(for: party) == nil)
        #expect(store.storedSlugs().isEmpty)
        // A new join waits for "forget me" to reach the file, then follows it.
        store.save(joined, for: other)
        #expect(mirror.inner.credentials(for: other) == nil)
        mirror.failsRemoveAll = false
        store.update(for: other) { $0.mute(participantID: "p2") }
        #expect(mirror.inner.credentials(for: party) == nil)
        #expect(mirror.inner.credentials(for: other)?.mutedParticipantIDs == ["p2"])
        #expect(store.credentials(for: party) == nil)
    }

    @Test func aFailedCopyIsRetriedBeforeTheNextChange() {
        let mirror = FlakyStore()
        mirror.inner.save(joined, for: party)
        let store = ClipSessionStore(mirror: mirror)
        mirror.failsWrites = true
        store.removeCredentials(for: party)
        #expect(mirror.inner.credentials(for: party) != nil)
        // Still gone in the session, though the file has it.
        #expect(store.credentials(for: party) == nil)
        mirror.failsWrites = false
        store.save(joined, for: other)
        #expect(mirror.inner.credentials(for: party) == nil)
        #expect(mirror.inner.credentials(for: other) != nil)
    }

    @Test func aPartialChangeNeverReplacesAnEntryItCouldntRead() {
        let mirror = FlakyStore()
        mirror.inner.save(joined, for: party)
        mirror.failsReads = true
        let store = ClipSessionStore(mirror: mirror)
        store.update(for: party) {
            $0.accessGrant = "grant"
            $0.accessGrantExpiresAt = stampTime
        }
        #expect(store.credentials(for: party)?.accessGrant == "grant")
        #expect(mirror.inner.credentials(for: party)?.guestToken == "gt_clip")
        #expect(mirror.inner.credentials(for: party)?.accessGrant == nil)
        // A join brings a token of its own, so it does replace it.
        var rejoined = joined
        rejoined.guestToken = "gt_new"
        store.save(rejoined, for: party)
        #expect(mirror.inner.credentials(for: party)?.guestToken == "gt_new")
    }

    @Test func anEntryThatCouldntBeReadIsReadAgainLater() {
        let mirror = FlakyStore()
        mirror.inner.save(joined, for: party)
        mirror.failsReads = true
        let store = ClipSessionStore(mirror: mirror)
        #expect(store.credentials(for: party) == nil)
        mirror.failsReads = false
        #expect(store.credentials(for: party)?.guestToken == "gt_clip")
    }
}
