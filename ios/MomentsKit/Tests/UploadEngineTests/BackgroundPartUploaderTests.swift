import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import UploadEngine

private let account = "0123456789abcdef0123456789abcdef"

/// A 12-byte staged file; the background uploader runs on an ephemeral
/// session with the storage stub (URLProtocol can't serve background
/// sessions), through the same delegate code path.
private struct BackgroundSetup: @unchecked Sendable {
    let folder: TempFolder
    let staging: StagingArea
    let service = PartURLService()
    let item: QueuedUpload
    let ref: QueuedUpload.SessionRef

    init(partSize: Int64 = 5) throws {
        folder = try TempFolder()
        staging = StagingArea(root: folder.url)
        let id = UUID()
        try FileManager.default.createDirectory(at: staging.folder(for: id), withIntermediateDirectories: true)
        try Data("abcdefghijkl".utf8).write(to: staging.folder(for: id).appending(path: "a.jpg"))
        item = QueuedUpload(
            id: id, eventSlug: "party",
            file: .init(relativePath: StagingArea.relativePath(for: id, name: "a.jpg"), size: 12, contentType: "image/jpeg")!,
            caption: nil, createdAt: Date()
        )
        ref = QueuedUpload.SessionRef(id: "u1", partSize: partSize, partCount: Int((12 + partSize - 1) / partSize))
        StorageStub.reset()
    }

    func uploader(maxPartFiles: Int = BackgroundPartUploader.defaultMaxPartFiles) -> BackgroundPartUploader {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StorageStub.self]
        return BackgroundPartUploader(
            service: service, staging: staging, hosts: .r2Account(account)!, configuration: configuration, maxPartFiles: maxPartFiles
        )
    }

    func upload(_ parts: [Int], with uploader: BackgroundPartUploader) async throws -> Set<Int> {
        let file = try staging.open(item.file, owner: item.id)
        return try await uploader.upload(
            parts: parts, session: ref, item: item, file: file, credentials: EventCredentials(guestToken: "gt-test")
        )
    }

    var partFiles: [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: staging.root.appending(path: ".parts").path())) ?? []
    }
}

/// Polls until `condition` holds; fails the test after ~2 s.
private func eventually(_ condition: () -> Bool, sourceLocation: SourceLocation = #_sourceLocation) async throws {
    for _ in 0 ..< 200 where !condition() {
        try await Task.sleep(for: .milliseconds(10))
    }
    try #require(condition(), sourceLocation: sourceLocation)
}

private let tagU1 = PartTaskKey.sessionTag("u1")

private func partNumber(_ url: URL) -> Int { StorageTarget.partNumber(in: url) ?? 0 }

// Shares the storage stub, so it runs inside the serialized suite.
extension URLSessionPartUploaderTests {
    @Test func backgroundSendsEveryPartAndDeletesItsFile() async throws {
        let setup = try BackgroundSetup()
        #expect(try await setup.upload([3, 1, 2, 2], with: setup.uploader()) == [1, 2, 3])
        #expect(setup.service.requested == [[1, 2, 3]])
        let bodies = StorageStub.sent.sorted { partNumber($0.url) < partNumber($1.url) }.map(\.body)
        #expect(bodies == [Data("abcde".utf8), Data("fghij".utf8), Data("kl".utf8)])
        #expect(StorageStub.sent.allSatisfy { $0.method == "PUT" && !$0.headers.keys.contains { $0.lowercased() == "x-guest-token" } })
        try await eventually { setup.partFiles.isEmpty }
        #expect(setup.partFiles.isEmpty)
    }

    @Test func backgroundBoundsThePartFilesInFlight() async throws {
        let setup = try BackgroundSetup(partSize: 1)
        let staging = setup.staging
        let most = Counter()
        StorageStub.onStart = { _ in
            let count = (try? FileManager.default.contentsOfDirectory(atPath: staging.root.appending(path: ".parts").path()).count) ?? 0
            most.raise(to: count)
            Thread.sleep(forTimeInterval: 0.005)
        }
        #expect(try await setup.upload(Array(1 ... 12), with: setup.uploader(maxPartFiles: 2)) == Set(1 ... 12))
        #expect(most.value >= 1 && most.value <= 2)
    }

    @Test func backgroundReportsProgressAndRethrowsRefusals() async throws {
        let setup = try BackgroundSetup()
        let uploader = setup.uploader()
        StorageStub.respond = { request in
            request.url!.query()!.contains("partNumber=2") ? (500, [:]) : (200, ["ETag": "\"e\""])
        }
        #expect(try await setup.upload([1, 2, 3], with: uploader) == [1, 3])
        StorageStub.respond = { request in
            request.url!.query()!.contains("partNumber=2") ? (413, [:]) : (200, ["ETag": "\"e\""])
        }
        await #expect(throws: MomentsAPIError.invalidUpload) { try await setup.upload([1, 2, 3], with: uploader) }
        StorageStub.respond = { _ in (200, [:]) }
        await #expect(throws: MomentsAPIError.unexpectedResponse) { try await setup.upload([1], with: uploader) }
        try await eventually { setup.partFiles.isEmpty }
        #expect(setup.partFiles.isEmpty)
    }

    @Test func backgroundRefusesURLsOffOurStorage() async throws {
        let setup = try BackgroundSetup()
        setup.service.hosts = [2: "ffffffffffffffffffffffffffffffff.r2.cloudflarestorage.com"]
        await #expect(throws: MomentsAPIError.unexpectedResponse) { try await setup.upload([1, 2], with: setup.uploader()) }
        #expect(StorageStub.sent.isEmpty)
    }

    @Test func backgroundCancellingStopsTheWaitNotTheUpload() async throws {
        let setup = try BackgroundSetup()
        let uploader = setup.uploader()
        let gate = DispatchSemaphore(value: 0)
        StorageStub.onStart = { _ in gate.wait() }
        defer { gate.signal() }
        let waiting = Task { try await setup.upload([1], with: uploader) }
        try await eventually { !StorageStub.sent.isEmpty }
        waiting.cancel()
        await #expect(throws: CancellationError.self) { try await waiting.value }
        gate.signal()
        try await eventually { setup.partFiles.isEmpty }
        try await Task.sleep(for: .milliseconds(20))
        // Asked again: the finished result is used, nothing is sent twice.
        #expect(try await setup.upload([1], with: uploader) == [1])
        #expect(StorageStub.sent.count == 1)
        #expect(setup.service.requested.count == 1)
    }

    @Test func backgroundRecoverDeletesPartFilesNoTaskIsSending() async throws {
        let setup = try BackgroundSetup()
        let folder = try setup.staging.partsFolder()
        try Data("photo".utf8).write(to: folder.appending(path: PartTaskKey(item: setup.item.id, part: 1, session: tagU1).fileName))
        try await setup.uploader().recover()
        #expect(setup.partFiles.isEmpty)
    }

    @Test func clearingPartFilesKeepsOnlyNamedPlainFiles() throws {
        let setup = try BackgroundSetup()
        let folder = try setup.staging.partsFolder()
        let outside = setup.folder.url.appending(path: "outside")
        try Data("keep".utf8).write(to: outside)
        for name in ["live", "orphan"] { try Data("x".utf8).write(to: folder.appending(path: name)) }
        try FileManager.default.createSymbolicLink(at: folder.appending(path: "link"), withDestinationURL: outside)
        try FileManager.default.createDirectory(at: folder.appending(path: "dir"), withIntermediateDirectories: true)
        try setup.staging.clearPartFiles(keeping: ["live", "link", "dir"])
        #expect(setup.partFiles == ["live"])
        #expect(FileManager.default.fileExists(atPath: outside.path()))
    }

    @Test func partTaskKeysRoundTripAndRejectJunk() {
        let key = PartTaskKey(item: UUID(), part: 12, session: tagU1)
        #expect(PartTaskKey(label: key.label) == key && PartTaskKey(fileName: key.fileName) == key)
        #expect(PartTaskKey(label: key.fileName) == nil && PartTaskKey(fileName: key.label) == nil)
        #expect(tagU1.count == 16 && tagU1 == PartTaskKey.sessionTag("u1") && tagU1 != PartTaskKey.sessionTag("u2"))
        let (id, attempt) = (key.item.uuidString, key.attempt.uuidString)
        for junk in [
            "", "x:1:\(tagU1):\(attempt)", "\(id):0:\(tagU1):\(attempt)", "\(id):-1:\(tagU1):\(attempt)",
            "\(id.lowercased()):1:\(tagU1):\(attempt)", "\(id):01:\(tagU1):\(attempt)", "\(id):1:\(tagU1.uppercased()):\(attempt)",
            "\(id):1:abc:\(attempt)", "\(id):1:\(tagU1)", "\(id):1:\(tagU1):\(attempt):x", "../\(id):1:\(tagU1):\(attempt)",
        ] {
            #expect(PartTaskKey(label: junk) == nil)
        }
        #expect(PartTaskKey(label: nil) == nil)
    }

    @Test func outcomeTreatsARedirectAsAFailure() {
        let signed = URL(string: "https://\(account).r2.cloudflarestorage.com/b/k?partNumber=1")!
        let ok = HTTPURLResponse(url: signed, statusCode: 200, httpVersion: nil, headerFields: ["ETag": "\"e\""])
        let policy = StorageHostPolicy.r2Account(account)!
        #expect((try? BackgroundPartUploader.outcome(original: signed, final: signed, response: ok, error: nil, hosts: policy).get()) != nil)
        // Same host and path, another query: still a redirect.
        let requery = URL(string: "https://\(account).r2.cloudflarestorage.com/b/k?partNumber=2")!
        #expect(failure(BackgroundPartUploader.outcome(original: signed, final: requery, response: ok, error: nil, hosts: policy)) == .unexpectedResponse)
        // Not our storage at all, even unredirected (an adopted task).
        let foreign = URL(string: "https://ffffffffffffffffffffffffffffffff.r2.cloudflarestorage.com/b/k?partNumber=1")!
        #expect(failure(BackgroundPartUploader.outcome(original: foreign, final: foreign, response: ok, error: nil, hosts: policy)) == .unexpectedResponse)
        let moved = URL(string: "https://elsewhere.example.com/b/k")!
        #expect(failure(BackgroundPartUploader.outcome(original: signed, final: moved, response: ok, error: nil, hosts: policy)) == .unexpectedResponse)
        #expect(failure(BackgroundPartUploader.outcome(original: signed, final: nil, response: ok, error: nil, hosts: policy)) == .unexpectedResponse)
        #expect(
            failure(BackgroundPartUploader.outcome(original: signed, final: signed, response: nil, error: URLError(.timedOut), hosts: policy))
                == .transport(.timedOut)
        )
        let gone = HTTPURLResponse(url: signed, statusCode: 404, httpVersion: nil, headerFields: nil)
        #expect(failure(BackgroundPartUploader.outcome(original: signed, final: signed, response: gone, error: nil, hosts: policy)) == .uploadNotOpen)
    }

    @Test func taskBookKeepsResultsNoOneWaitedFor() async throws {
        let tasks = PartTasks()
        let key = PartTaskKey(item: UUID(), part: 1, session: tagU1)
        #expect(tasks.take(key.slot, session: tagU1) == nil)
        tasks.start(key)
        tasks.finish(key, .success(()))
        // A late adopt doesn't hide the result.
        tasks.adopt(PartTaskKey(item: key.item, part: 1, session: tagU1))
        guard case .finished(.success) = tasks.take(key.slot, session: tagU1) else { Issue.record("result lost"); return }
        #expect(tasks.take(key.slot, session: tagU1) == nil)
        // A waiter gets a result that arrives later.
        tasks.start(key)
        let waited = Task { try await tasks.wait(for: key) }
        try await Task.sleep(for: .milliseconds(20))
        tasks.finish(key, .failure(.storageUnavailable))
        await #expect(throws: MomentsAPIError.storageUnavailable) { try await waited.value }
        #expect(tasks.take(key.slot, session: tagU1) == nil)
    }

    @Test func taskBookIgnoresLateReportsFromOlderAttempts() async throws {
        let tasks = PartTasks()
        let old = PartTaskKey(item: UUID(), part: 1, session: tagU1)
        let new = PartTaskKey(item: old.item, part: 1, session: tagU1)
        tasks.adopt(old)
        // The queue resends before the old attempt reports.
        tasks.start(new)
        tasks.finish(old, .failure(.transport(.cancelled)))
        guard case let .running(running) = tasks.take(new.slot, session: tagU1), running == new else {
            Issue.record("old report replaced the new attempt"); return
        }
        tasks.finish(new, .success(()))
        tasks.finish(old, .failure(.storageUnavailable))
        guard case .finished(.success) = tasks.take(new.slot, session: tagU1) else { Issue.record("new result lost"); return }
    }

    @Test func taskBookNeverCountsAnotherSessionsParts() {
        let tasks = PartTasks()
        let old = PartTaskKey(item: UUID(), part: 1, session: PartTaskKey.sessionTag("old"))
        tasks.start(old)
        #expect(tasks.take(old.slot, session: tagU1) == nil)
        tasks.finish(old, .success(()))
        #expect(tasks.take(old.slot, session: tagU1) == nil)
        // And the stale result is gone, not waiting for its session.
        #expect(tasks.take(old.slot, session: old.session) == nil)
    }

    @Test func taskBookTellsReplacedWaitersToRetry() async throws {
        let tasks = PartTasks()
        let old = PartTaskKey(item: UUID(), part: 1, session: tagU1)
        tasks.start(old)
        let waited = Task { try await tasks.wait(for: old) }
        try await Task.sleep(for: .milliseconds(20))
        tasks.start(PartTaskKey(item: old.item, part: 1, session: tagU1))
        await #expect(throws: MomentsAPIError.storageUnavailable) { try await waited.value }
    }

    @Test func taskBookDropsResultsWhenFull() {
        let tasks = PartTasks()
        let item = UUID()
        for part in 1 ... PartTasks.maxFinished + 1 {
            tasks.finish(PartTaskKey(item: item, part: part, session: tagU1), .success(()))
        }
        #expect(tasks.take(PartSlot(item: item, part: 1), session: tagU1) == nil)
        #expect(tasks.take(PartSlot(item: item, part: PartTasks.maxFinished + 1), session: tagU1) != nil)
    }

    @Test func backgroundEventsCompletionRunsOnceOnMain() async throws {
        let setup = try BackgroundSetup()
        let uploader = setup.uploader()
        let calls = Counter()
        let onMain = Counter()
        uploader.handleBackgroundEvents {
            if Thread.isMainThread { onMain.raise(to: 1) }
            calls.raise(to: calls.value + 1)
        }
        let events = try #require(uploader.sessionDelegate as? SessionEvents)
        events.urlSessionDidFinishEvents(forBackgroundURLSession: URLSession.shared)
        events.urlSessionDidFinishEvents(forBackgroundURLSession: URLSession.shared)
        try await eventually { calls.value == 1 }
        try await Task.sleep(for: .milliseconds(20))
        #expect(calls.value == 1 && onMain.value == 1)
    }
}

/// A thread-safe running maximum.
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var current = 0
    var value: Int { lock.withLock { current } }
    func raise(to count: Int) { lock.withLock { current = max(current, count) } }
}

private func failure(_ result: Result<Void, MomentsAPIError>) -> MomentsAPIError? {
    if case let .failure(error) = result { error } else { nil }
}

@MainActor
@Suite struct BackgroundCompletionTests {
    private final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var names: [String] = []
        func add(_ name: String) { lock.withLock { names.append(name) } }
        var all: [String] { lock.withLock { names } }
    }

    /// Lets main-queue work posted so far run.
    private func flushMain() async {
        await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } }
    }

    @Test func releasesTheHandlerWhenEventsFinishAfterIt() async {
        let tasks = PartTasks(), calls = Calls()
        tasks.setBackgroundCompletion { calls.add("a") }
        #expect(calls.all.isEmpty)
        let completion = tasks.takeBackgroundCompletion()
        completion?()
        #expect(calls.all == ["a"])
        #expect(tasks.takeBackgroundCompletion() == nil)
    }

    @Test func releasesAHandlerArrivingAfterTheEventsFinished() async {
        let tasks = PartTasks(), calls = Calls()
        #expect(tasks.takeBackgroundCompletion() == nil)
        tasks.setBackgroundCompletion { calls.add("late") }
        await flushMain()
        #expect(calls.all == ["late"])
        // Remembered once only: the next handler waits for its own events.
        tasks.setBackgroundCompletion { calls.add("next") }
        await flushMain()
        #expect(calls.all == ["late"])
    }

    @Test func neverDropsAnEarlierHandler() async {
        let tasks = PartTasks(), calls = Calls()
        tasks.setBackgroundCompletion { calls.add("first") }
        tasks.setBackgroundCompletion { calls.add("second") }
        await flushMain()
        #expect(calls.all == ["first"])
        tasks.takeBackgroundCompletion()?()
        #expect(calls.all == ["first", "second"])
    }
}
