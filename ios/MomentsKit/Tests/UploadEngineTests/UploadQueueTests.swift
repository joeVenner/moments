import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import UploadEngine

private let partSize: Int64 = 8 * 1024 * 1024

/// A server that keeps sessions in memory and finishes them once every
/// part arrived. Failures can be scripted per call.
final class FakeUploadServer: UploadService, PartUploader, @unchecked Sendable {
    private let lock = NSLock()
    private var sessions: [String: UploadSession] = [:]
    private var stored: [String: Set<Int>] = [:]
    var failNext: [MomentsAPIError] = []
    /// What the part uploader accepts (nil: everything asked).
    var acceptParts: Set<Int>?
    private(set) var calls: [String] = []

    private func record(_ call: String) throws {
        try lock.withLock {
            calls.append(call)
            if !failNext.isEmpty { throw failNext.removeFirst() }
        }
    }

    func startUpload(_ upload: NewUpload, slug: String, credentials: EventCredentials) async throws -> UploadSession {
        try record("start")
        return lock.withLock {
            let id = "u-\(upload.clientUploadID.uuidString.prefix(8))"
            let session = sessions[id] ?? UploadSession(
                id: id, clientUploadID: upload.clientUploadID, status: .open, contentType: upload.contentType,
                size: upload.size, partSize: partSize, partCount: UploadPlan.partCount(size: upload.size, partSize: partSize)!,
                createdAt: Date(timeIntervalSince1970: 0)
            )
            sessions[id] = session
            return session
        }
    }

    func uploadProgress(slug: String, uploadID: String, credentials: EventCredentials) async throws -> UploadProgress {
        try record("progress")
        return lock.withLock { UploadProgress(session: sessions[uploadID]!, uploadedParts: stored[uploadID] ?? []) }
    }

    func partURLs(slug: String, uploadID: String, parts: [Int]?, credentials: EventCredentials) async throws -> PartURLBatch {
        fatalError("not used by the queue")
    }

    func completeUpload(slug: String, uploadID: String, credentials: EventCredentials) async throws -> CompleteOutcome {
        try record("complete")
        return lock.withLock {
            let session = sessions[uploadID]!
            let missing = UploadPlan.missingParts(partCount: session.partCount, uploaded: stored[uploadID] ?? [])
            guard missing.isEmpty else { return .incomplete(uploadedParts: stored[uploadID] ?? []) }
            let done = UploadSession(
                id: session.id, clientUploadID: session.clientUploadID, status: .completed, contentType: session.contentType,
                size: session.size, partSize: session.partSize, partCount: session.partCount, createdAt: session.createdAt,
                momentID: "m1"
            )
            sessions[uploadID] = done
            return .completed(done)
        }
    }

    func abortUpload(slug: String, uploadID: String, credentials: EventCredentials) async throws -> UploadSession {
        fatalError("not used by the queue")
    }

    func upload(
        parts: [Int], session: QueuedUpload.SessionRef, item: QueuedUpload, credentials: EventCredentials
    ) async throws -> Set<Int> {
        try record("parts")
        return lock.withLock {
            let accepted = Set(parts).intersection(acceptParts ?? Set(parts))
            stored[session.id, default: []].formUnion(accepted)
            return accepted
        }
    }
}

/// A clock tests move by hand.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_000_000)
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current.addTimeInterval(seconds) } }
}

private struct Harness {
    let folder: TempFolder
    let server = FakeUploadServer()
    let clock = TestClock()
    let store: QueueStore
    let staging: StagingArea

    init(maxItems: Int = QueueStore.defaultMaxItems) throws {
        folder = try TempFolder()
        store = QueueStore(directory: folder.url.appending(path: "queue"), maxItems: maxItems)
        staging = StagingArea(root: folder.url.appending(path: "staging"))
        try FileManager.default.createDirectory(at: staging.root, withIntermediateDirectories: true)
    }

    func queue(signedIn: Bool = true) -> UploadQueue {
        let clock = clock
        return UploadQueue(
            store: store, staging: staging, service: server, partUploader: server,
            credentials: { _ in signedIn ? EventCredentials(guestToken: "gt-test") : nil },
            now: { clock.now }, jitter: { _ in 0 }
        )
    }

    /// A staged file of `size` bytes and its queue item.
    func stage(_ name: String, size: Int = 10) throws -> QueuedUpload {
        try Data(count: size).write(to: staging.root.appending(path: name))
        return QueuedUpload(
            eventSlug: "party", file: .init(relativePath: name, size: Int64(size), contentType: "image/jpeg")!,
            caption: nil, createdAt: clock.now
        )
    }

    func stagedFileExists(_ name: String) -> Bool {
        FileManager.default.fileExists(atPath: staging.root.appending(path: name).path())
    }
}

/// Runs due actions until nothing is due right now.
private func drain(_ queue: UploadQueue) async {
    for _ in 0 ..< 20 where await queue.runDue().didWork {}
}

@Suite struct UploadQueueTests {
    @Test func uploadsAnItemAndCleansUpItsFile() async throws {
        let harness = try Harness()
        let queue = harness.queue()
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        await drain(queue)

        #expect(await queue.snapshot().first?.phase == .done(momentID: "m1"))
        #expect(harness.server.calls == ["start", "parts", "complete"])
        #expect(!harness.stagedFileExists("a.jpg"))
        // Saved as done, so a relaunch doesn't send it again.
        #expect(try harness.store.load().items.first?.phase == .done(momentID: "m1"))
    }

    @Test func refusesMissingDuplicateAndOverflowingItems() async throws {
        let harness = try Harness(maxItems: 1)
        let queue = harness.queue()
        let item = try harness.stage("a.jpg")
        let missing = QueuedUpload(
            eventSlug: "party", file: .init(relativePath: "gone.jpg", size: 10, contentType: "image/jpeg")!,
            caption: nil, createdAt: harness.clock.now
        )
        await #expect(throws: UploadQueue.EnqueueError.file(.missing)) { try await queue.enqueue(missing) }
        try await queue.enqueue(item)
        await #expect(throws: UploadQueue.EnqueueError.duplicate) { try await queue.enqueue(item) }
        await #expect(throws: UploadQueue.EnqueueError.full) { try await queue.enqueue(try harness.stage("b.jpg")) }
    }

    @Test func countsUnloadedRecordsTowardTheCap() async throws {
        let harness = try Harness(maxItems: 1)
        let locked = try harness.stage("a.jpg")
        try harness.store.save(locked)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: harness.store.recordURL(for: locked.id).path())
        let queue = harness.queue()
        #expect(try await queue.load().deferred == 1)
        await #expect(throws: UploadQueue.EnqueueError.full) { try await queue.enqueue(try harness.stage("b.jpg")) }
        // Its staged file is left alone.
        #expect(harness.stagedFileExists("a.jpg"))
    }

    @Test func rereadsTheSessionAfterARelaunch() async throws {
        let harness = try Harness()
        let first = harness.queue()
        let item = try harness.stage("a.jpg")
        try await first.enqueue(item)
        harness.server.failNext = [.transport(.notConnectedToInternet)]
        await first.step(id: item.id) // start fails offline
        harness.clock.advance(60)
        await first.step(id: item.id) // start succeeds; parts not sent yet

        let second = harness.queue()
        try await second.load()
        #expect(await second.snapshot().first?.nextAction(now: harness.clock.now) == .readSession(.init(
            id: "u-\(item.id.uuidString.prefix(8))", partSize: partSize, partCount: 1
        )))
        await drain(second)
        #expect(harness.server.calls == ["start", "start", "progress", "parts", "complete"])
    }

    @Test func failsWithoutCredentials() async throws {
        let harness = try Harness()
        let queue = harness.queue(signedIn: false)
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        await drain(queue)
        #expect(await queue.snapshot().first?.phase == .failed(.accessLost))
        #expect(harness.server.calls.isEmpty)
    }

    @Test func failsWhenTheStagedFileDisappears() async throws {
        let harness = try Harness()
        let queue = harness.queue()
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        await queue.step(id: item.id)
        try FileManager.default.removeItem(at: harness.staging.root.appending(path: "a.jpg"))
        await drain(queue)
        #expect(await queue.snapshot().first?.phase == .failed(.fileLost))
        #expect(harness.server.calls == ["start"])
    }

    @Test func treatsNoAcceptedPartsAsAFailureAndBacksOff() async throws {
        let harness = try Harness()
        let queue = harness.queue()
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        harness.server.acceptParts = []
        await drain(queue)
        let upload = try #require(await queue.snapshot().first)
        #expect(upload.attempts == 1 && upload.phase == .uploading)
        #expect(harness.server.calls == ["start", "parts"])
        #expect(await queue.runDue().next == harness.clock.now.addingTimeInterval(5))

        harness.server.acceptParts = nil
        harness.clock.advance(5)
        await drain(queue)
        #expect(await queue.snapshot().first?.phase == .done(momentID: "m1"))
    }

    @Test func waitsOutABackOff() async throws {
        let harness = try Harness()
        let queue = harness.queue()
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        harness.server.failNext = [.storageUnavailable]
        await drain(queue)
        #expect(harness.server.calls == ["start"])
        harness.clock.advance(4)
        await drain(queue)
        #expect(harness.server.calls == ["start"])
        harness.clock.advance(1)
        await drain(queue)
        #expect(await queue.snapshot().first?.phase == .done(momentID: "m1"))
    }

    @Test func retriesAndDiscardsFailedItems() async throws {
        let harness = try Harness()
        let queue = harness.queue()
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        harness.server.failNext = [.upgradeRequired]
        await drain(queue)
        #expect(await queue.snapshot().first?.phase == .failed(.appTooOld))

        await queue.retry(id: item.id)
        await drain(queue)
        #expect(await queue.snapshot().first?.phase == .done(momentID: "m1"))
        try await queue.clearDone()
        #expect(await queue.snapshot().isEmpty)
        #expect(try harness.store.load().items.isEmpty)
    }

    @Test func discardKeepsUnfinishedItems() async throws {
        let harness = try Harness()
        let queue = harness.queue()
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        try await queue.discard(id: item.id)
        #expect(await queue.snapshot().count == 1)
        #expect(harness.stagedFileExists("a.jpg"))
    }

    @Test func publishesChanges() async throws {
        let harness = try Harness()
        let queue = harness.queue()
        var updates = await queue.updates().makeAsyncIterator()
        #expect(await updates.next() == [])
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        #expect(await updates.next()?.map(\.id) == [item.id])
    }

    @Test func runLoopWakesOnEnqueue() async throws {
        let harness = try Harness()
        let queue = harness.queue()
        let runner = Task { await queue.run() }
        defer { runner.cancel() }
        var updates = await queue.updates().makeAsyncIterator()
        try await queue.enqueue(try harness.stage("a.jpg"))
        var finished = false
        while let items = await updates.next() {
            if items.first?.phase == .done(momentID: "m1") { finished = true; break }
        }
        #expect(finished)
    }
}
