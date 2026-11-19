import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import FeatureGuest
@testable import UploadEngine

private let mib8: Int64 = 8 * 1024 * 1024
private let size = 2 * mib8 + 100
private let t0 = Date(timeIntervalSince1970: 1_000_000)

private func item(_ slug: String = "party", type: String = "image/jpeg", caption: String? = "Cake") -> QueuedUpload {
    QueuedUpload(eventSlug: slug, file: .init(relativePath: "staged/a", size: size, contentType: type)!, caption: caption, createdAt: t0)
}

private func session(_ item: QueuedUpload, status: UploadSession.Status = .open, momentID: String? = nil) -> UploadSession {
    UploadSession(
        id: "u1", clientUploadID: item.clientUploadID, status: status, contentType: item.file.contentType,
        size: size, partSize: mib8, partCount: 3, createdAt: t0, momentID: momentID
    )
}

private func applying(_ events: (QueuedUpload) -> [QueuedUpload.Event], to start: QueuedUpload) -> QueuedUpload {
    var upload = start
    for event in events(upload) { upload.apply(event, now: t0) }
    return upload
}

/// Pushes queue states by hand and records the calls.
private actor FakeProgressSource: UploadProgressSource {
    private var continuation: AsyncStream<[QueuedUpload]>.Continuation?
    private(set) var retried: [UUID] = []
    private(set) var discarded: [UUID] = []
    private(set) var cleared = 0
    var failRemoval = false

    func updates() -> AsyncStream<[QueuedUpload]> {
        let (stream, continuation) = AsyncStream.makeStream(of: [QueuedUpload].self)
        self.continuation = continuation
        return stream
    }

    func push(_ queue: [QueuedUpload]) { continuation?.yield(queue) }
    func finish() { continuation?.finish() }
    func setFailRemoval(_ value: Bool) { failRemoval = value }

    func retry(id: UUID) { retried.append(id) }

    func discard(id: UUID) throws {
        if failRemoval { throw CocoaError(.fileWriteNoPermission) }
        discarded.append(id)
    }

    func clearDone() throws {
        if failRemoval { throw CocoaError(.fileWriteNoPermission) }
        cleared += 1
    }
}

@MainActor
private func settle(_ model: UploadProgressModel, until condition: () -> Bool) async {
    for _ in 0 ..< 200 where !condition() { await Task.yield() }
}

@Suite @MainActor struct UploadProgressModelTests {
    @Test func showsThisEventsItemsWithTheirStatus() async {
        let waiting = item()
        let sending = applying({ [.sessionStarted(session($0)), .partsUploaded([1], sessionID: "u1")] }, to: item(type: "video/mp4", caption: nil))
        let done = applying({ [.sessionStarted(session($0, status: .completed, momentID: "m1"))] }, to: item())
        let lost = applying({ [.fileLost(clientUploadID: $0.clientUploadID)] }, to: item())
        let elsewhere = item("other")

        let source = FakeProgressSource()
        let model = UploadProgressModel(eventSlug: "party", source: source)
        let observing = Task { await model.observe() }
        await settle(model) { false }
        await source.push([waiting, sending, done, lost, elsewhere])
        await settle(model) { model.rows.count == 4 }

        #expect(model.rows.map(\.status) == [
            .waiting, .uploading(1.0 / 3), .done, .failed(.fileLost, canRetry: false),
        ])
        #expect(model.rows[1].isVideo && model.rows[1].caption == nil)
        #expect(model.activeCount == 2 && model.failedCount == 1 && model.doneCount == 1)
        // The failed one stays out of the bar: (0 + 1/3 + 1) / 3.
        #expect(abs(model.overallFraction - 4.0 / 9) < 0.000_001)
        #expect(model.headline == .sharing(2))
        await source.finish()
        await observing.value
    }

    @Test func retriesOnlyWhatCanBeRetriedAndRemovesOnlyFinished() async {
        let stuck = applying({ [.requestFailed(.accessRequired, clientUploadID: $0.clientUploadID)] }, to: item())
        let lost = applying({ [.fileLost(clientUploadID: $0.clientUploadID)] }, to: item())
        let waiting = item()
        #expect(stuck.canRetryByGuest)

        let source = FakeProgressSource()
        let model = UploadProgressModel(eventSlug: "party", source: source)
        let observing = Task { await model.observe() }
        await settle(model) { false }
        await source.push([stuck, lost, waiting])
        await settle(model) { model.rows.count == 3 }

        await model.retry(stuck.id)
        await model.retry(lost.id)
        await model.retry(waiting.id)
        #expect(await source.retried == [stuck.id])

        await model.remove(waiting.id)
        await model.remove(lost.id)
        #expect(await source.discarded == [lost.id])

        // No finished uploads: nothing to clear.
        await model.clearDone()
        #expect(await source.cleared == 0)
        await source.finish()
        await observing.value
    }

    @Test func reportsARemovalThatFailed() async {
        let done = applying({ [.sessionStarted(session($0, status: .completed, momentID: "m1"))] }, to: item())
        let source = FakeProgressSource()
        let model = UploadProgressModel(eventSlug: "party", source: source)
        let observing = Task { await model.observe() }
        await settle(model) { false }
        await source.push([done])
        await settle(model) { model.rows.count == 1 }

        await source.setFailRemoval(true)
        await model.clearDone()
        #expect(model.couldNotRemove)
        await source.setFailRemoval(false)
        await model.clearDone()
        let cleared = await source.cleared
        #expect(!model.couldNotRemove && cleared == 1)
        await source.finish()
        await observing.value
    }
}

@Suite struct UploadProgressRowMappingTests {
    @Test func backingOffShowsAsWaiting() {
        let failedOnce = applying({ [.sessionStarted(session($0)), .partsUploaded([1], sessionID: "u1"), .requestFailed(.transport(.timedOut), clientUploadID: $0.clientUploadID)] }, to: item())
        #expect(failedOnce.retryAt != nil && !failedOnce.isFinished)
        #expect(UploadProgressModel.row(failedOnce).status == .waiting)
    }

    @Test func finishingIsShown() {
        let sent = applying({ [.sessionStarted(session($0)), .partsUploaded([1, 2, 3], sessionID: "u1")] }, to: item())
        #expect(sent.phase == .finishing)
        #expect(UploadProgressModel.row(sent).status == .finishing)
    }
}

@Suite struct UploadProgressOverallTests {
    @MainActor @Test func anEmptyQueueIsAllSharedAtNothing() {
        let model = UploadProgressModel(eventSlug: "party", source: FakeProgressSource())
        #expect(model.overallFraction == 0)
        #expect(model.headline == .allShared)
    }

    private func row(_ status: UploadProgressModel.Status) -> UploadProgressModel.Row {
        .init(id: UUID(), isVideo: false, caption: nil, status: status)
    }

    @Test func eachItemCountsHowFarItIs() {
        #expect(row(.waiting).fraction == 0)
        #expect(row(.uploading(0.4)).fraction == 0.4)
        #expect(row(.uploading(1.7)).fraction == 1)
        #expect(row(.finishing).fraction == 1)
        #expect(row(.done).fraction == 1)
        #expect(row(.failed(.gaveUp, canRetry: true)).fraction == 0)
    }
}
