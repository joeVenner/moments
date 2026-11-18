import Foundation
import Testing
@testable import FeatureGuest
@testable import MediaPipeline
import UploadEngine

/// Scripted importer: answers per pick file name, records discards.
private final class FakeImporter: MediaImporting, @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [String: [Result<PreparedMedia, MediaImporter.Problem>]] = [:]
    private(set) var discarded: [String] = []
    private(set) var imported: [String] = []
    /// While set, imports wait for it.
    var gate: AsyncStream<Void>.Continuation?
    private var gateStream: AsyncStream<Void>?

    func answer(_ name: String, _ results: Result<PreparedMedia, MediaImporter.Problem>...) {
        lock.withLock { answers[name] = results }
    }

    func hold() {
        let (stream, continuation) = AsyncStream<Void>.makeStream()
        gateStream = stream
        gate = continuation
    }

    func importMedia(_ picked: PickedMedia, into folder: URL) async throws(MediaImporter.Problem) -> PreparedMedia {
        if let gateStream { for await _ in gateStream { break } }
        let name = picked.url.lastPathComponent
        let result = lock.withLock { () -> Result<PreparedMedia, MediaImporter.Problem> in
            imported.append(name)
            return answers[name]?.isEmpty == false ? answers[name]!.removeFirst() : .success(.photo())
        }
        return try result.get()
    }

    func discard(_ picked: PickedMedia) {
        lock.withLock { discarded.append(picked.url.lastPathComponent) }
    }
}

private actor FakeSubmitter: UploadSubmitting {
    var submitted: [QueuedUpload] = []
    var failure: (any Error)?
    func fail(with error: (any Error)?) { failure = error }
    func submit(_ upload: QueuedUpload) async throws {
        if let failure { throw failure }
        submitted.append(upload)
    }
}

extension PreparedMedia {
    static func photo(bytes: Int64 = 1000) -> PreparedMedia {
        PreparedMedia(name: "photo.jpg", contentType: "image/jpeg", byteCount: bytes, width: 10, height: 10, duration: nil)
    }

    static func video() -> PreparedMedia {
        PreparedMedia(name: "video.mp4", contentType: "video/mp4", byteCount: 5000, width: 10, height: 10, duration: 3)
    }
}

private func loader(_ name: String, _ kind: PickedMedia.Kind = .photo) -> PickLoader {
    { PickedMedia(url: URL(filePath: "/picked/\(name)"), kind: kind) }
}

@MainActor
private func settle(_ model: UploadModel) async {
    for _ in 0 ..< 200 where model.isPreparing { try? await Task.sleep(for: .milliseconds(5)) }
}

@MainActor
struct UploadModelTests {
    let staging = StagingArea(root: FileManager.default.temporaryDirectory.appending(path: "UploadModelTests-\(UUID().uuidString)"))

    @Test func preparesPicksThenSharesThemWithTheCaption() async throws {
        let importer = FakeImporter()
        importer.answer("b.mov", .success(.video()))
        let submitter = FakeSubmitter()
        let model = UploadModel(eventSlug: "party", staging: staging, importer: importer, submitter: submitter, now: { Date(timeIntervalSince1970: 1) })
        model.add([loader("a.jpg"), loader("b.mov", .video)])
        #expect(model.items.count == 2 && model.isPreparing && !model.canShare)
        await settle(model)
        #expect(model.readyCount == 2 && model.hasVideo)
        model.caption = "  Cake time!  "
        await model.share()
        let sent = await submitter.submitted
        #expect(sent.map(\.id) == model.items.map(\.id))
        #expect(sent.allSatisfy { $0.caption == "Cake time!" && $0.eventSlug == "party" })
        #expect(sent[0].file.relativePath == "\(model.items[0].id.uuidString)/photo.jpg")
        #expect(sent[1].file.contentType == "video/mp4" && sent[1].file.size == 5000)
        #expect(model.items.allSatisfy { $0.state == .shared } && model.caption.isEmpty)
        #expect(importer.imported == ["a.jpg", "b.mov"])
    }

    @Test func anEmptyCaptionIsSentAsNone() async throws {
        let submitter = FakeSubmitter()
        let model = UploadModel(eventSlug: "party", staging: staging, importer: FakeImporter(), submitter: submitter)
        model.add([loader("a.jpg")])
        await settle(model)
        model.caption = "   "
        await model.share()
        #expect(await submitter.submitted.first?.caption == nil)
    }

    @Test func refusesCaptionsTheServerWould() {
        #expect(UploadModel.cleanCaption(" hi\nthere ") == "hi\nthere")
        #expect(UploadModel.cleanCaption("tab\there") == nil)
        #expect(UploadModel.cleanCaption("bell\u{7}") == nil)
        #expect(UploadModel.cleanCaption(String(repeating: "a", count: 500)) != nil)
        #expect(UploadModel.cleanCaption(String(repeating: "a", count: 501)) == nil)
        // Counted like the server (UTF-16): 250 emoji are 500 units.
        #expect(UploadModel.cleanCaption(String(repeating: "🎉", count: 250)) != nil)
        #expect(UploadModel.cleanCaption(String(repeating: "🎉", count: 251)) == nil)
    }

    @Test func failuresAreShownAndRetryableOnesCanBeRetried() async throws {
        let importer = FakeImporter()
        importer.answer("a.jpg", .failure(.failed), .success(.photo()))
        importer.answer("b.jpg", .failure(.unsupported))
        let model = UploadModel(eventSlug: "party", staging: staging, importer: importer, submitter: FakeSubmitter())
        model.add([loader("a.jpg"), loader("b.jpg"), { nil }])
        await settle(model)
        #expect(model.items.map(\.state) == [.failed(.failed), .failed(.unsupported), .failed(.unsupported)])
        #expect(model.items.map(\.canRetry) == [true, false, false])
        // Nothing ready: can't share.
        #expect(!model.canShare)
        model.retry(model.items[1].id)
        #expect(model.items[1].state == .failed(.unsupported))
        model.retry(model.items[0].id)
        await settle(model)
        #expect(model.items[0].state == .ready(.photo()))
        // The retry used the held pick, not the picker again.
        #expect(importer.imported == ["a.jpg", "b.jpg", "a.jpg"])
    }

    @Test func removingDiscardsTheHeldPickAndFiles() async throws {
        let importer = FakeImporter()
        importer.answer("a.jpg", .failure(.noSpace))
        let model = UploadModel(eventSlug: "party", staging: staging, importer: importer, submitter: FakeSubmitter())
        model.add([loader("a.jpg")])
        await settle(model)
        let id = model.items[0].id
        try FileManager.default.createDirectory(at: staging.folder(for: id), withIntermediateDirectories: true)
        model.remove(id)
        #expect(model.items.isEmpty && importer.discarded == ["a.jpg"])
        #expect(!FileManager.default.fileExists(atPath: staging.folder(for: id).path()))
    }

    @Test func removingAnItemBeingPreparedDropsItsResult() async throws {
        let importer = FakeImporter()
        importer.hold()
        let model = UploadModel(eventSlug: "party", staging: staging, importer: importer, submitter: FakeSubmitter())
        model.add([loader("a.jpg"), loader("b.jpg")])
        try await Task.sleep(for: .milliseconds(30))
        let first = model.items[0].id
        try FileManager.default.createDirectory(at: staging.folder(for: first), withIntermediateDirectories: true)
        model.remove(first)
        importer.gate?.yield()
        importer.gate?.yield()
        await settle(model)
        #expect(model.items.count == 1 && model.readyCount == 1)
        #expect(!FileManager.default.fileExists(atPath: staging.folder(for: first).path()))
    }

    @Test func aFullQueueStopsSharingAndKeepsTheRest() async throws {
        let submitter = FakeSubmitter()
        let model = UploadModel(eventSlug: "party", staging: staging, importer: FakeImporter(), submitter: submitter)
        model.add([loader("a.jpg"), loader("b.jpg")])
        await settle(model)
        await submitter.fail(with: UploadQueue.EnqueueError.full)
        await model.share()
        #expect(model.shareProblem == .queueFull && model.readyCount == 2)
        await submitter.fail(with: nil)
        await model.share()
        #expect(model.shareProblem == nil && model.readyCount == 0)
    }

    @Test func capsTheNumberOfPicks() {
        let model = UploadModel(eventSlug: "party", staging: staging, importer: FakeImporter(), submitter: FakeSubmitter())
        model.add(Array(repeating: loader("a.jpg"), count: UploadModel.maxPicks + 5))
        #expect(model.items.count == UploadModel.maxPicks)
    }
}
