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
    /// Answers start with a session for another client id.
    var answerForeignSessions = false
    /// Runs before parts are accepted (to hold the request open).
    var beforeParts: (@Sendable () async -> Void)?

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
            let clientID = answerForeignSessions ? UUID() : upload.clientUploadID
            let session = sessions[id] ?? UploadSession(
                id: id, clientUploadID: clientID, status: .open, contentType: upload.contentType,
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

    /// Sizes asked for, per call.
    private(set) var thumbnailSizes: [Int] = []
    /// The thumbnail URL call fails (whatever else is scripted).
    var thumbnailURLFails = false

    func thumbnailURL(slug: String, uploadID: String, size: Int, credentials: EventCredentials) async throws -> ThumbnailURL {
        try record("thumbnail-url")
        if lock.withLock({ thumbnailURLFails }) { throw MomentsAPIError.uploadsUnavailable }
        lock.withLock { thumbnailSizes.append(size) }
        return ThumbnailURL(expiresAt: Date(timeIntervalSince1970: 2_000_000), url: URL(string: "https://r2.test/\(uploadID).thumb-upload.jpg")!)
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

    private(set) var recoveries = 0
    func recover() async throws {
        lock.withLock { recoveries += 1 }
    }

    func upload(
        parts: [Int], session: QueuedUpload.SessionRef, item: QueuedUpload, file: FileHandle,
        credentials: EventCredentials
    ) async throws -> Set<Int> {
        try record("parts")
        if let beforeParts { await beforeParts() }
        // Like URLSession: a cancelled request fails rather than answers.
        if Task.isCancelled { throw MomentsAPIError.transport(.cancelled) }
        return lock.withLock {
            let accepted = Set(parts).intersection(acceptParts ?? Set(parts))
            stored[session.id, default: []].formUnion(accepted)
            return accepted
        }
    }
}

/// Records the thumbnails it is asked to send; can be made to fail.
final class FakeThumbnailSender: ThumbnailSender, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var sent: [(data: Data, url: URL)] = []
    private var failing = false
    var fails: Bool {
        get { lock.withLock { failing } }
        set { lock.withLock { failing = newValue } }
    }

    func send(_ data: Data, to url: URL) async throws {
        try lock.withLock {
            if failing { throw URLSessionThumbnailSender.Problem.refused(status: 403) }
            sent.append((data, url))
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
    let thumbnails = FakeThumbnailSender()
    let clock = TestClock()
    let store: QueueStore
    let staging: StagingArea

    init(maxItems: Int = QueueStore.defaultMaxItems) throws {
        folder = try TempFolder()
        store = QueueStore(directory: folder.url.appending(path: "queue"), maxItems: maxItems)
        staging = StagingArea(root: folder.url.appending(path: "staging"))
        try FileManager.default.createDirectory(at: staging.root, withIntermediateDirectories: true)
    }

    /// A queue that loaded the (empty) saved queue.
    func queue(credentials: CredentialsLookupResult = .found(EventCredentials(guestToken: "gt-test"))) async throws -> UploadQueue {
        let queue = unloadedQueue(credentials: credentials)
        try await queue.load()
        return queue
    }

    func unloadedQueue(credentials: CredentialsLookupResult = .found(EventCredentials(guestToken: "gt-test"))) -> UploadQueue {
        let clock = clock
        return UploadQueue(
            store: store, staging: staging, service: server, partUploader: server,
            credentials: { _ in credentials }, thumbnailSender: thumbnails,
            now: { clock.now }, jitter: { _ in 0 }
        )
    }

    /// A staged file of `size` bytes and its queue item.
    func stage(_ name: String = "a.jpg", size: Int = 10, thumbnail: Data? = nil) throws -> QueuedUpload {
        let id = UUID()
        try FileManager.default.createDirectory(at: staging.folder(for: id), withIntermediateDirectories: true)
        try Data(count: size).write(to: staging.folder(for: id).appending(path: name))
        var thumb: QueuedUpload.StagedFile?
        if let thumbnail {
            try thumbnail.write(to: staging.folder(for: id).appending(path: "thumb.jpg"))
            thumb = .init(relativePath: StagingArea.relativePath(for: id, name: "thumb.jpg"), size: Int64(thumbnail.count), contentType: "image/jpeg")
        }
        return QueuedUpload(
            id: id, eventSlug: "party",
            file: .init(relativePath: StagingArea.relativePath(for: id, name: name), size: Int64(size), contentType: "image/jpeg")!,
            thumbnail: thumb, caption: nil, createdAt: clock.now
        )
    }

    func thumbnailExists(_ item: QueuedUpload) -> Bool {
        guard let thumbnail = item.thumbnail else { return false }
        return FileManager.default.fileExists(atPath: staging.root.appending(path: thumbnail.relativePath).path())
    }

    func stagedFileExists(_ item: QueuedUpload) -> Bool {
        FileManager.default.fileExists(atPath: staging.root.appending(path: item.file.relativePath).path())
    }
}

/// Runs due actions until nothing is due right now.
private func drain(_ queue: UploadQueue) async {
    for _ in 0 ..< 20 where await queue.runDue().didWork {}
}

@Suite struct UploadQueueTests {
    @Test func loadLetsTheUploaderRecoverFirst() async throws {
        let harness = try Harness()
        let queue = harness.unloadedQueue()
        #expect(harness.server.recoveries == 0)
        try await queue.load()
        #expect(harness.server.recoveries == 1)
        await #expect(throws: UploadQueue.EnqueueError.alreadyLoaded) { try await queue.load() }
        #expect(harness.server.recoveries == 1)
    }

    @Test func uploadsAnItemAndCleansUpItsFile() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        await drain(queue)

        #expect(await queue.snapshot().first?.phase == .done(momentID: "m1"))
        #expect(harness.server.calls == ["start", "parts", "complete"])
        #expect(!harness.stagedFileExists(item))
        // Saved as done, so a relaunch doesn't send it again.
        #expect(try harness.store.load().items.first?.phase == .done(momentID: "m1"))
    }

    @Test func refusesMissingDuplicateAndOverflowingItems() async throws {
        let harness = try Harness(maxItems: 1)
        let queue = try await harness.queue()
        let item = try harness.stage("a.jpg")
        let missingID = UUID()
        let missing = QueuedUpload(
            id: missingID, eventSlug: "party",
            file: .init(relativePath: StagingArea.relativePath(for: missingID, name: "gone.jpg"), size: 10, contentType: "image/jpeg")!,
            caption: nil, createdAt: harness.clock.now
        )
        let foreign = QueuedUpload(
            eventSlug: "party", file: .init(relativePath: "other/a.jpg", size: 10, contentType: "image/jpeg")!,
            caption: nil, createdAt: harness.clock.now
        )
        await #expect(throws: UploadQueue.EnqueueError.file(.outsideStaging)) { try await queue.enqueue(foreign) }
        await #expect(throws: UploadQueue.EnqueueError.file(.missing)) { try await queue.enqueue(missing) }
        try await queue.enqueue(item)
        await #expect(throws: UploadQueue.EnqueueError.duplicate) { try await queue.enqueue(item) }
        await #expect(throws: UploadQueue.EnqueueError.full) { try await queue.enqueue(try harness.stage("b.jpg")) }
    }

    @Test func countsUnloadedRecordsTowardTheCap() async throws {
        let harness = try Harness(maxItems: 1)
        let locked = try harness.stage("a.jpg")
        let item = locked
        try harness.store.save(locked)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: harness.store.recordURL(for: locked.id).path())
        let queue = harness.unloadedQueue()
        #expect(try await queue.load().deferred == 1)
        await #expect(throws: UploadQueue.EnqueueError.full) { try await queue.enqueue(try harness.stage("b.jpg")) }
        // Its staged file is left alone.
        #expect(harness.stagedFileExists(item))
    }

    @Test func rereadsTheSessionAfterARelaunch() async throws {
        let harness = try Harness()
        let first = try await harness.queue()
        let item = try harness.stage("a.jpg")
        try await first.enqueue(item)
        harness.server.failNext = [.transport(.notConnectedToInternet)]
        await first.step(id: item.id) // start fails offline
        harness.clock.advance(60)
        await first.step(id: item.id) // start succeeds; parts not sent yet

        let second = harness.unloadedQueue()
        try await second.load()
        #expect(await second.snapshot().first?.nextAction(now: harness.clock.now) == .readSession(.init(
            id: "u-\(item.id.uuidString.prefix(8))", partSize: partSize, partCount: 1
        )))
        await drain(second)
        #expect(harness.server.calls == ["start", "start", "progress", "parts", "complete"])
    }

    @Test func failsWithoutCredentials() async throws {
        let harness = try Harness()
        let queue = try await harness.queue(credentials: .missing)
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        await drain(queue)
        #expect(await queue.snapshot().first?.phase == .failed(.accessLost))
        #expect(harness.server.calls.isEmpty)
    }

    @Test func failsWhenTheStagedFileDisappears() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        await queue.step(id: item.id)
        try FileManager.default.removeItem(at: harness.staging.root.appending(path: item.file.relativePath))
        await drain(queue)
        #expect(await queue.snapshot().first?.phase == .failed(.fileLost))
        #expect(harness.server.calls == ["start"])
    }

    @Test func treatsNoAcceptedPartsAsAFailureAndBacksOff() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
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
        let queue = try await harness.queue()
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
        let queue = try await harness.queue()
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
        let queue = try await harness.queue()
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        try await queue.discard(id: item.id)
        #expect(await queue.snapshot().count == 1)
        #expect(harness.stagedFileExists(item))
    }

    @Test func publishesChanges() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        var updates = await queue.updates().makeAsyncIterator()
        #expect(await updates.next() == [])
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        #expect(await updates.next()?.map(\.id) == [item.id])
    }

    @Test func runLoopWakesOnEnqueue() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
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

    @Test func holdsInsteadOfSpinningOnIgnoredAnswers() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        try await queue.enqueue(try harness.stage())
        harness.server.answerForeignSessions = true
        #expect(await queue.runDue() == (false, harness.clock.now.addingTimeInterval(UploadQueue.noProgressHold)))
        await drain(queue)
        #expect(harness.server.calls == ["start"])
        harness.clock.advance(UploadQueue.noProgressHold)
        await drain(queue)
        #expect(harness.server.calls == ["start", "start"])
    }

    @Test func holdsWhileCredentialsAreUnavailable() async throws {
        let harness = try Harness()
        let queue = try await harness.queue(credentials: .unavailable)
        let item = try harness.stage()
        try await queue.enqueue(item)
        await drain(queue)
        let upload = try #require(await queue.snapshot().first)
        #expect(upload.phase == .prepared && upload.attempts == 0)
        #expect(await queue.runDue().next == harness.clock.now.addingTimeInterval(UploadQueue.unreadableHold))
    }

    @Test func cancellingTheRunDoesNotCountATry() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let item = try harness.stage()
        try await queue.enqueue(item)
        await queue.step(id: item.id) // session open
        let gate = Gate()
        harness.server.beforeParts = { await gate.wait() }
        harness.server.failNext = []
        let runner = Task { await queue.runDue() }
        while !harness.server.calls.contains("parts") { await Task.yield() }
        runner.cancel()
        await gate.open()
        _ = await runner.value
        let upload = try #require(await queue.snapshot().first)
        #expect(upload.attempts == 0 && upload.phase == .uploading && upload.retryAt == nil)
    }

    @Test func keepsTheFileWhenDoneCannotBeSaved() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let item = try harness.stage()
        try await queue.enqueue(item)
        await queue.step(id: item.id)
        await queue.step(id: item.id)
        let directory = harness.store.directory.path()
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory) }
        await queue.step(id: item.id)
        #expect(await queue.snapshot().first?.phase == .done(momentID: "m1"))
        #expect(await queue.saveFailures == 1)
        #expect(harness.stagedFileExists(item))
    }

    @Test func loadsOnceBeforeEnqueueing() async throws {
        let harness = try Harness()
        let queue = harness.unloadedQueue()
        await #expect(throws: UploadQueue.EnqueueError.notLoaded) { try await queue.enqueue(try harness.stage()) }
        try await queue.load()
        await #expect(throws: UploadQueue.EnqueueError.alreadyLoaded) { try await queue.load() }
    }

    @Test func holdsWhileTheStagedFileIsUnreadable() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let item = try harness.stage()
        try await queue.enqueue(item)
        await queue.step(id: item.id)
        let path = harness.staging.root.appending(path: item.file.relativePath).path()
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: path)
        await drain(queue)
        #expect(await queue.snapshot().first?.phase == .uploading)
        #expect(await queue.runDue().next == harness.clock.now.addingTimeInterval(UploadQueue.unreadableHold))
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
        harness.clock.advance(UploadQueue.unreadableHold)
        await drain(queue)
        #expect(await queue.snapshot().first?.phase == .done(momentID: "m1"))
    }
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

@Suite struct UploadLaunchTests {
    @Test func loadsThenSweepsOnlyFoldersNoRecordOwns() async throws {
        let harness = try Harness()
        // A queued item from an earlier run, and a folder prepared but never queued.
        let earlier = harness.unloadedQueue()
        try await earlier.load()
        let queued = try harness.stage("a.jpg")
        try await earlier.enqueue(queued)
        let orphan = try harness.stage("b.jpg")

        let queue = harness.unloadedQueue()
        let report = await UploadLaunch.prepare(
            queue: queue, store: harness.store, staging: harness.staging, launchedAt: Date().addingTimeInterval(60)
        )

        #expect(report.loaded?.items.map(\.id) == [queued.id])
        #expect(report.swept == 1)
        #expect(harness.stagedFileExists(queued))
        #expect(!harness.stagedFileExists(orphan))
        #expect(harness.server.recoveries == 2)
    }

    @Test func keepsTheFolderOfARecordOverTheCap() async throws {
        let harness = try Harness(maxItems: 1)
        let earlier = harness.unloadedQueue()
        try await earlier.load()
        let first = try harness.stage("a.jpg")
        try await earlier.enqueue(first)
        // A second record written directly (another launch, a larger cap).
        let second = try harness.stage("b.jpg")
        try harness.store.save(second)

        let report = await UploadLaunch.prepare(
            queue: harness.unloadedQueue(), store: harness.store, staging: harness.staging, launchedAt: Date().addingTimeInterval(60)
        )

        #expect(report.loaded?.overflow == 1)
        #expect(report.swept == 0)
        #expect(harness.stagedFileExists(second))
    }

    @Test func sweepsNothingWhenLoadIsRefused() async throws {
        let harness = try Harness()
        let orphan = try harness.stage("b.jpg")
        let queue = harness.unloadedQueue()
        try await queue.load()

        // A second load is refused: nothing is known about the owners.
        let report = await UploadLaunch.prepare(
            queue: queue, store: harness.store, staging: harness.staging, launchedAt: Date().addingTimeInterval(60)
        )

        #expect(report == UploadLaunch.Report(loaded: nil, swept: nil))
        #expect(harness.stagedFileExists(orphan))
    }
}

@Suite struct UploadQueueSettleTests {
    @Test func settleCarriesAnItemThroughToDone() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)

        await queue.settle(within: 5)

        #expect(await queue.snapshot().first?.phase == .done(momentID: "m1"))
    }

    @Test func settleReturnsAtOnceWithNothingToDo() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let started = Date()
        await queue.settle(within: 5)
        #expect(Date().timeIntervalSince(started) < 1)
    }
}

@Suite struct UploadQueueLeavingTests {
    private func other(_ harness: Harness) throws -> QueuedUpload {
        let item = try harness.stage("b.jpg")
        return QueuedUpload(id: item.id, eventSlug: "other", file: item.file, caption: nil, createdAt: item.createdAt)
    }

    @Test func removesOnlyThatEventsItemsAndTheirFiles() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let mine = try harness.stage()
        let kept = try other(harness)
        try await queue.enqueue(mine)
        try await queue.enqueue(kept)

        #expect(await queue.beginLeaving(eventSlug: "party") == 1)

        #expect(await queue.snapshot().map(\.id) == [kept.id])
        #expect(!harness.stagedFileExists(mine))
        #expect(harness.stagedFileExists(kept))
        #expect(try harness.store.recordIDs() == [kept.id])
    }

    @Test func removesRecordsNotLoadedAtLaunch() async throws {
        let harness = try Harness(maxItems: 1)
        let loaded = try harness.stage()
        let overCap = try harness.stage("b.jpg")
        let otherEvent = try other(harness)
        for item in [loaded, overCap, otherEvent] { try harness.store.save(item) }
        // One of the three loads (the cap); the others stay on disk only.
        let queue = try await harness.queue()

        #expect(await queue.beginLeaving(eventSlug: "party") == 2)
        #expect(try harness.store.recordIDs() == [otherEvent.id])
        #expect(!harness.stagedFileExists(loaded) && !harness.stagedFileExists(overCap))
        #expect(harness.stagedFileExists(otherEvent))
    }

    @Test func waitsForARequestAlreadyRunning() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let item = try harness.stage()
        try await queue.enqueue(item)
        await queue.step(id: item.id) // session open
        let gate = Gate()
        harness.server.beforeParts = { await gate.wait() }
        let sending = Task { await queue.step(id: item.id) }
        while !harness.server.calls.contains("parts") { await Task.yield() }

        let leaving = Task { await queue.beginLeaving(eventSlug: "party") }
        try await Task.sleep(for: .milliseconds(200))
        #expect(await queue.snapshot().count == 1) // still waiting
        await gate.open()
        _ = await sending.value

        #expect(await leaving.value == 1)
        #expect(await queue.snapshot().isEmpty)
        #expect(!harness.stagedFileExists(item))
    }

    @Test func removesARequestStillRunningAfterTheWait() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let item = try harness.stage()
        try await queue.enqueue(item)
        await queue.step(id: item.id)
        let gate = Gate()
        harness.server.beforeParts = { await gate.wait() }
        let sending = Task { await queue.step(id: item.id) }
        while !harness.server.calls.contains("parts") { await Task.yield() }

        #expect(await queue.beginLeaving(eventSlug: "party", waitingAtMost: .milliseconds(100)) == 1)
        await gate.open()
        #expect(await sending.value == false) // the late answer changes nothing
        #expect(await queue.snapshot().isEmpty)
        #expect(try harness.store.recordIDs().isEmpty)
    }

    @Test func staysClosedUntilEveryLeaveEnds() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        await queue.beginLeaving(eventSlug: "party")
        await queue.beginLeaving(eventSlug: "party")
        await #expect(throws: UploadQueue.EnqueueError.leaving) { try await queue.enqueue(try harness.stage()) }
        await queue.endLeaving(eventSlug: "party")
        await #expect(throws: UploadQueue.EnqueueError.leaving) { try await queue.enqueue(try harness.stage()) }
        await queue.endLeaving(eventSlug: "party")
        let item = try harness.stage()
        try await queue.enqueue(item)
        #expect(await queue.step(id: item.id))
    }

    @Test func aCancelledLeaveDoesntWaitOut() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let item = try harness.stage()
        try await queue.enqueue(item)
        await queue.step(id: item.id)
        let gate = Gate()
        harness.server.beforeParts = { await gate.wait() }
        let sending = Task { await queue.step(id: item.id) }
        while !harness.server.calls.contains("parts") { await Task.yield() }

        let started = ContinuousClock.now
        let leaving = Task { await queue.beginLeaving(eventSlug: "party") }
        leaving.cancel()
        #expect(await leaving.value == 1)
        #expect(ContinuousClock.now - started < .seconds(5))
        await gate.open()
        _ = await sending.value
    }
}

// MARK: - Thumbnails

private let thumbnailBytes = Data([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 0xFF, 0xD9])

@Suite struct UploadQueueThumbnailTests {
    @Test func sendsTheThumbnailOnceBeforeThePartsAndCleansItUp() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let item = try harness.stage(thumbnail: thumbnailBytes)
        try await queue.enqueue(item)
        await drain(queue)
        #expect(harness.server.calls == ["start", "thumbnail-url", "parts", "complete"])
        #expect(harness.server.thumbnailSizes == [thumbnailBytes.count])
        #expect(harness.thumbnails.sent.map(\.data) == [thumbnailBytes])
        #expect(await queue.snapshot().first?.phase == .done(momentID: "m1"))
        #expect(!harness.stagedFileExists(item) && !harness.thumbnailExists(item))
    }

    enum ThumbnailFailure: CaseIterable { case urlRefused, putRefused, fileUnreadable }

    @Test(arguments: ThumbnailFailure.allCases)
    func aFailedThumbnailNeverHoldsTheUploadBack(failure: ThumbnailFailure) async throws {
        do {
            let harness = try Harness()
            let queue = try await harness.queue()
            let item = try harness.stage(thumbnail: thumbnailBytes)
            switch failure {
            case .urlRefused: harness.server.thumbnailURLFails = true
            case .putRefused: harness.thumbnails.fails = true
            case .fileUnreadable:
                // Replaced by a folder: can't be opened as the recorded file.
                let path = harness.staging.root.appending(path: try #require(item.thumbnail).relativePath)
                try FileManager.default.removeItem(at: path)
                try FileManager.default.createDirectory(at: path, withIntermediateDirectories: false)
            }
            try await queue.enqueue(item)
            await drain(queue)
            #expect(await queue.snapshot().first?.phase == .done(momentID: "m1"))
            #expect(await queue.thumbnailFailures == 1)
            // Tried once, never again.
            #expect(harness.server.calls.filter { $0 == "thumbnail-url" }.count == (failure == .fileUnreadable ? 0 : 1))
        }
    }

    @Test func skipsAThumbnailThatChangedSize() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let item = try harness.stage(thumbnail: thumbnailBytes)
        try Data([0xFF, 0xD8]).write(to: harness.staging.root.appending(path: try #require(item.thumbnail).relativePath))
        try await queue.enqueue(item)
        await drain(queue)
        #expect(harness.server.calls == ["start", "parts", "complete"])
        #expect(harness.thumbnails.sent.isEmpty)
        #expect(await queue.thumbnailFailures == 1)
    }

    @Test func leavingRemovesTheThumbnailToo() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let item = try harness.stage(thumbnail: thumbnailBytes)
        try await queue.enqueue(item)
        #expect(await queue.beginLeaving(eventSlug: "party") == 1)
        #expect(!harness.stagedFileExists(item) && !harness.thumbnailExists(item))
    }

    @Test func aRecordSavedBeforeThumbnailsStillLoads() throws {
        let harness = try Harness()
        let item = try harness.stage()
        var json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(item)) as? [String: Any])
        json["thumbnail"] = nil
        json["thumbnailSentFor"] = nil
        let decoded = try JSONDecoder().decode(QueuedUpload.self, from: JSONSerialization.data(withJSONObject: json))
        #expect(decoded.thumbnail == nil && decoded.id == item.id)
        // A thumbnail that isn't a JPEG is dropped, not the record.
        let thumbed = try harness.stage(thumbnail: thumbnailBytes)
        var tampered = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(thumbed)) as? [String: Any])
        var thumb = try #require(tampered["thumbnail"] as? [String: Any])
        thumb["contentType"] = "text/html"
        tampered["thumbnail"] = thumb
        let kept = try JSONDecoder().decode(QueuedUpload.self, from: JSONSerialization.data(withJSONObject: tampered))
        #expect(kept.thumbnail == nil && kept.id == thumbed.id)
    }
}

// MARK: - Thumbnail decisions

@Suite struct QueuedUploadThumbnailTests {
    private static func item(thumbnail: Bool = true) -> QueuedUpload {
        let id = UUID()
        return QueuedUpload(
            id: id, eventSlug: "party",
            file: .init(relativePath: StagingArea.relativePath(for: id, name: "a.jpg"), size: 10, contentType: "image/jpeg")!,
            thumbnail: thumbnail ? .init(relativePath: StagingArea.relativePath(for: id, name: "thumb.jpg"), size: 9, contentType: "image/jpeg") : nil,
            caption: nil, createdAt: Date(timeIntervalSince1970: 0)
        )
    }

    private static func session(_ id: String, for item: QueuedUpload, status: UploadSession.Status = .open) -> UploadSession {
        UploadSession(
            id: id, clientUploadID: item.clientUploadID, status: status, contentType: "image/jpeg", size: 10,
            partSize: 8 * 1024 * 1024, partCount: 1, createdAt: Date(timeIntervalSince1970: 0)
        )
    }

    @Test func sendsOncePerSessionAndAgainAfterARestart() throws {
        let now = Date(timeIntervalSince1970: 10)
        var item = Self.item()
        item.apply(.sessionStarted(Self.session("u-a", for: item)), now: now)
        guard case .sendThumbnail = item.nextAction(now: now) else { Issue.record("expected the thumbnail first"); return }
        // An answer for another session changes nothing.
        let before = item
        item.apply(.thumbnailHandled(sessionID: "u-other"), now: now)
        #expect(item == before)
        item.apply(.thumbnailHandled(sessionID: "u-a"), now: now)
        guard case .uploadParts = item.nextAction(now: now) else { Issue.record("expected the parts"); return }
        // The session was cancelled: a fresh one sends the thumbnail again.
        item.reconcileOnLaunch()
        item.apply(.progressRead(UploadProgress(session: Self.session("u-a", for: item, status: .aborted), uploadedParts: [])), now: now)
        guard case let .startSession(upload) = item.nextAction(now: now) else { Issue.record("expected a restart"); return }
        var restarted = Self.session("u-b", for: item)
        restarted = UploadSession(
            id: "u-b", clientUploadID: upload.clientUploadID, status: .open, contentType: "image/jpeg", size: 10,
            partSize: restarted.partSize, partCount: 1, createdAt: restarted.createdAt
        )
        item.apply(.sessionStarted(restarted), now: now)
        guard case let .sendThumbnail(session, _) = item.nextAction(now: now) else { Issue.record("expected the thumbnail again"); return }
        #expect(session.id == "u-b")
    }

    @Test func aRelaunchDoesntSendItAgain() {
        let now = Date(timeIntervalSince1970: 10)
        var item = Self.item()
        item.apply(.sessionStarted(Self.session("u-a", for: item)), now: now)
        item.apply(.thumbnailHandled(sessionID: "u-a"), now: now)
        item.reconcileOnLaunch()
        item.apply(.progressRead(UploadProgress(session: Self.session("u-a", for: item), uploadedParts: [1])), now: now)
        guard case .complete = item.nextAction(now: now) else { Issue.record("expected complete"); return }
    }

    @Test func withoutAThumbnailNothingChanges() {
        let now = Date(timeIntervalSince1970: 10)
        var item = Self.item(thumbnail: false)
        item.apply(.sessionStarted(Self.session("u-a", for: item)), now: now)
        guard case .uploadParts = item.nextAction(now: now) else { Issue.record("expected the parts"); return }
    }
}

@Suite struct UploadQueueResumeTests {
    @Test func comingBackTriesAnOfflineUploadAtOnce() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        harness.server.failNext = [.transport(.networkConnectionLost)]
        await queue.step(id: item.id) // the Clip was suspended mid-request
        #expect(await queue.snapshot().first?.retryAt ?? .distantPast > harness.clock.now)
        await queue.resume()
        #expect(await queue.snapshot().first?.retryAt == harness.clock.now)
        // Saved too, so a relaunch doesn't wait either.
        #expect(try await harness.unloadedQueueLoadingRetryAt(of: item.id) == harness.clock.now)
        await queue.step(id: item.id)
        #expect(harness.server.calls == ["start", "start"])
    }

    @Test func aRequestCutOffBeforeComingBackStillGoesSoon() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        // Back in front first; the cut-off request fails just after.
        await queue.resume()
        harness.clock.advance(1)
        harness.server.failNext = [.transport(.networkConnectionLost)]
        await queue.step(id: item.id)
        #expect(await queue.snapshot().first?.retryAt == harness.clock.now.addingTimeInterval(UploadQueue.resumedRetry))
        // Later, a lost network waits the usual time again.
        harness.clock.advance(UploadQueue.resumeWindow)
        harness.server.failNext = [.transport(.networkConnectionLost)]
        await queue.step(id: item.id)
        #expect(await queue.snapshot().first?.retryAt == harness.clock.now.addingTimeInterval(QueuedUpload.offlineWait))
    }

    @Test func comingBackLeavesARealFailuresWait() async throws {
        let harness = try Harness()
        let queue = try await harness.queue()
        let item = try harness.stage("a.jpg")
        try await queue.enqueue(item)
        harness.server.failNext = [.rateLimited]
        await queue.step(id: item.id)
        let wait = await queue.snapshot().first?.retryAt
        await queue.resume()
        #expect(await queue.snapshot().first?.retryAt == wait)
    }
}

private extension Harness {
    func unloadedQueueLoadingRetryAt(of id: UUID) async throws -> Date? {
        let queue = unloadedQueue()
        try await queue.load()
        return await queue.snapshot().first { $0.id == id }?.retryAt
    }
}

/// Each item remembers which guest queued it, as a one-way tag.
@Suite struct QueuedUploadOwnerTests {
    @Test func theTagIsOneWayAndStable() {
        let tag = QueuedUpload.ownerTag(guestToken: "gt-secret")
        #expect(tag == QueuedUpload.ownerTag(guestToken: "gt-secret"))
        #expect(tag != QueuedUpload.ownerTag(guestToken: "gt-other"))
        #expect(tag.count == 32 && tag.allSatisfy(\.isHexDigit) && tag == tag.lowercased())
        #expect(!tag.contains("secret"))
    }

    @Test func enqueuingMarksTheGuestWhoQueuedIt() async throws {
        let harness = try Harness()
        let queue = try await harness.queue(credentials: .found(EventCredentials(guestToken: "gt-test")))
        try await queue.enqueueOwned(harness.stage("a.jpg"))
        #expect(await queue.snapshot().first?.owner == QueuedUpload.ownerTag(guestToken: "gt-test"))
        // Saved too: the app reads it from the Clip's folder.
        let id = try #require(await queue.snapshot().first?.id)
        guard case let .item(saved) = harness.store.read(harness.store.recordURL(for: id)) else {
            Issue.record("not saved")
            return
        }
        #expect(saved.owner == QueuedUpload.ownerTag(guestToken: "gt-test"))
    }

    @Test func noGuestMeansNoMark() async throws {
        let harness = try Harness()
        let queue = try await harness.queue(credentials: .unavailable)
        try await queue.enqueueOwned(harness.stage("a.jpg"))
        #expect(await queue.snapshot().first?.owner == nil)
    }

    /// Records from before the mark, or with a damaged one, still load.
    @Test func aMissingOrBadMarkStillLoads() throws {
        let id = UUID()
        let item = QueuedUpload(
            id: id, eventSlug: "party",
            file: .init(relativePath: StagingArea.relativePath(for: id, name: "a.jpg"), size: 10, contentType: "image/jpeg")!,
            caption: nil, createdAt: Date(timeIntervalSince1970: 0)
        )
        var json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(item)) as? [String: Any])
        #expect(json["owner"] == nil)
        #expect(try JSONDecoder().decode(QueuedUpload.self, from: JSONSerialization.data(withJSONObject: json)).owner == nil)
        json["owner"] = "gt-raw-token"
        #expect(try JSONDecoder().decode(QueuedUpload.self, from: JSONSerialization.data(withJSONObject: json)).owner == nil)
        let tag = QueuedUpload.ownerTag(guestToken: "gt")
        json["owner"] = tag
        #expect(try JSONDecoder().decode(QueuedUpload.self, from: JSONSerialization.data(withJSONObject: json)).owner == tag)
    }
}
