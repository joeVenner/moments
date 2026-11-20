import Foundation
import Testing
@testable import FeatureGuest
import UploadEngine

struct QueueSubmitterTests {
    private struct DiskFull: Error {}

    private static func upload() throws -> QueuedUpload {
        let id = UUID()
        let file = try #require(QueuedUpload.StagedFile(
            relativePath: StagingArea.relativePath(for: id, name: "photo.jpg"), size: 10, contentType: "image/jpeg"
        ))
        return QueuedUpload(id: id, eventSlug: "party", file: file, caption: nil, createdAt: Date(timeIntervalSince1970: 0))
    }

    /// The app and the App Clip both queue through here: every item is
    /// marked with the guest who queued it (`UploadQueue.enqueueOwned`).
    @Test func theRealQueueMarksWhoQueuedEachItem() throws {
        let file = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Sources/FeatureGuest/QueueSubmitter.swift")
        let source = try String(contentsOf: file, encoding: .utf8)
        #expect(source.contains("enqueue = { try await queue.enqueueOwned($0) }"))
    }

    @Test func acceptsWhatTheQueueTakes() async throws {
        let submitter = QueueSubmitter { _ in }
        #expect(await submitter.submit(try Self.upload()) == .accepted)
    }

    @Test(arguments: [
        (UploadQueue.EnqueueError.duplicate, SubmitResult.duplicate),
        (.full, .full),
        (.file(.unreadable), .failed),
        (.file(.missing), .invalid),
        (.file(.outsideStaging), .invalid),
        (.file(.notAFile), .invalid),
        (.file(.sizeChanged), .invalid),
        (.notLoaded, .failed),
        (.alreadyLoaded, .failed),
        (.leaving, .failed),
    ])
    func mapsEachRefusal(error: UploadQueue.EnqueueError, expected: SubmitResult) async throws {
        let submitter = QueueSubmitter { _ in throw error }
        #expect(await submitter.submit(try Self.upload()) == expected)
    }

    @Test func aSaveFailureIsWorthAnotherTry() async throws {
        let submitter = QueueSubmitter { _ in throw DiskFull() }
        #expect(await submitter.submit(try Self.upload()) == .failed)
    }
}

extension QueueSubmitterTests {
    @Test func waitsForTheLaunchLoadAndFailsIfItDidnt() async throws {
        let enqueued = Counter()
        let ready = QueueSubmitter(isReady: { true }) { _ in await enqueued.add() }
        let broken = QueueSubmitter(isReady: { false }) { _ in await enqueued.add() }
        #expect(await ready.submit(try Self.upload()) == .accepted)
        #expect(await broken.submit(try Self.upload()) == .failed)
        #expect(await enqueued.value == 1)
    }
}

private actor Counter {
    private(set) var value = 0
    func add() { value += 1 }
}
