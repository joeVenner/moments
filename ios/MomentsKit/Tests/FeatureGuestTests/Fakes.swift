import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain

/// Scripted MomentsService: each call pops its next result and records the
/// credentials it was given.
final class FakeService: MomentsService, @unchecked Sendable {
    private let lock = NSLock()
    var accessResults: [Result<AccessGrant?, Error>] = []
    var eventResults: [Result<Event, Error>] = []
    var joinResults: [Result<JoinResult, Error>] = []
    var pageResults: [Result<FeedPage, Error>] = []
    var changesResults: [Result<FeedChanges, Error>] = []
    private(set) var accessCalls: [AccessCredential] = []
    private(set) var eventCalls: [EventCredentials] = []
    private(set) var joinCalls: [(nickname: String, credentials: EventCredentials)] = []
    private(set) var pageCalls: [(before: Int?, reactorID: String?, credentials: EventCredentials)] = []
    private(set) var changesCalls: [Int] = []

    func access(slug: String, credential: AccessCredential) async throws -> AccessGrant? {
        try lock.withLock { accessCalls.append(credential); return try accessResults.removeFirst().get() }
    }
    func event(slug: String, credentials: EventCredentials) async throws -> Event {
        try lock.withLock { eventCalls.append(credentials); return try eventResults.removeFirst().get() }
    }
    func join(slug: String, nickname: String, avatarSeed: String?, credentials: EventCredentials) async throws -> JoinResult {
        try lock.withLock { joinCalls.append((nickname, credentials)); return try joinResults.removeFirst().get() }
    }
    /// Runs before a page request answers (to hold it open in race tests).
    var beforePage: (@Sendable (_ before: Int?) async -> Void)?

    func feedPage(slug: String, before: Int?, limit: Int?, reactorID: String?, credentials: EventCredentials) async throws -> FeedPage {
        let result = lock.withLock { pageCalls.append((before, reactorID, credentials)); return pageResults.removeFirst() }
        if let beforePage { await beforePage(before) }
        try Task.checkCancellation()
        return try result.get()
    }
    func feedChanges(slug: String, since: Int, limit: Int?, reactorID: String?, credentials: EventCredentials) async throws -> FeedChanges {
        try lock.withLock { changesCalls.append(since); return try changesResults.removeFirst().get() }
    }
}

/// In-memory store whose writes can be made to fail (keychain locked, etc.).
final class FlakyStore: EventCredentialStore, @unchecked Sendable {
    private let inner = InMemoryEventCredentialStore()
    var failWrites = false
    var failReads = false
    struct StoreFailed: Error {}

    func credentials(for slug: EventSlug) throws -> StoredEventCredentials? {
        if failReads { throw StoreFailed() }
        return inner.credentials(for: slug)
    }
    func save(_ credentials: StoredEventCredentials, for slug: EventSlug) throws {
        if failWrites { throw StoreFailed() }
        inner.save(credentials, for: slug)
    }
    /// Like the real store, an update that changes nothing writes nothing.
    func update(for slug: EventSlug, _ change: (inout StoredEventCredentials) -> Void) throws {
        let original = inner.credentials(for: slug) ?? StoredEventCredentials()
        var value = original
        change(&value)
        guard value != original else { return }
        if failWrites { throw StoreFailed() }
        inner.update(for: slug, change)
    }
    func removeCredentials(for slug: EventSlug) throws { inner.removeCredentials(for: slug) }
    func removeAll() throws { inner.removeAll() }
}


/// A one-shot latch for holding a fake request open.
actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func open() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters.removeAll()
    }
}
