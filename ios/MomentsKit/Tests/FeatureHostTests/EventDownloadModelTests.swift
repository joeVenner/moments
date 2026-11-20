import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import FeatureHost

/// Writes a small temporary file per URL; fails the URLs it's told to.
private final class FakeDownloader: MediaDownloading, @unchecked Sendable {
    private let lock = NSLock()
    private var _requested: [URL] = []
    private var _files: [URL] = []
    var failing: Set<String> = []
    /// Fails like a cancelled URLSession task (and cancels the run).
    var cancelOnFailure = false
    var requested: [URL] { lock.withLock { _requested } }
    var files: [URL] { lock.withLock { _files } }

    func download(_ url: URL) async throws -> URL {
        lock.withLock { _requested.append(url) }
        if failing.contains(url.lastPathComponent) {
            if cancelOnFailure {
                withUnsafeCurrentTask { $0?.cancel() }
                throw URLError(.cancelled)
            }
            throw URLError(.badServerResponse)
        }
        let file = FileManager.default.temporaryDirectory.appending(path: "download-test-\(UUID().uuidString)")
        try Data("x".utf8).write(to: file)
        lock.withLock { _files.append(file) }
        return file
    }
}

private final class FakeSaver: MomentSaving, @unchecked Sendable {
    private let lock = NSLock()
    private var _saved: [Media.Kind] = []
    private var _calls = 0
    /// Throws this on the save call with that index (0-based).
    var errorAt: (index: Int, error: Error)?
    /// Cancels the running task once this many files are saved.
    var cancelAfter: Int?
    var saved: [Media.Kind] { lock.withLock { _saved } }

    func save(fileAt url: URL, kind: Media.Kind) async throws {
        #expect(FileManager.default.fileExists(atPath: url.path(percentEncoded: false)))
        let index = lock.withLock { defer { _calls += 1 }; return _calls }
        if let errorAt, errorAt.index == index { throw errorAt.error }
        lock.withLock { _saved.append(kind) }
        if let cancelAfter, saved.count == cancelAfter { withUnsafeCurrentTask { $0?.cancel() } }
    }
}

private let origin = URL(string: "https://moments.test")!
private let session = StoredHostSession(token: "hs_live", expiresAt: Date.distantFuture)

private func moment(_ id: String, kind: Media.Kind = .image, status: AdminMoment.Status = .approved, url: String? = nil) -> AdminMoment {
    AdminMoment(
        id: id, eventID: "a", uploaderName: "Sara", createdAt: Date(timeIntervalSince1970: 1_800_000_000),
        status: status, media: Media(kind: kind, url: url ?? "https://moments.test/media/\(id).jpg")
    )
}

@Suite @MainActor struct EventDownloadModelTests {
    private func model(
        _ moments: [AdminMoment], truncated: Bool = false, downloader: FakeDownloader = FakeDownloader(), saver: FakeSaver = FakeSaver()
    ) -> EventDownloadModel {
        let service = FakeHostService()
        service.momentsResult = .success(AdminMomentList(moments: moments, isTruncated: truncated))
        let host = HostAccount(service: service, store: FlakyHostStore(session))
        return EventDownloadModel(eventID: "a", origin: origin, service: service, account: host, downloader: downloader, saver: saver)
    }

    @Test func savesWhatGuestsSeeAndSkipsHiddenAndStreamVideos() async {
        let downloader = FakeDownloader()
        let saver = FakeSaver()
        let subject = model([
            moment("p1"),
            moment("v1", kind: .video, url: "https://moments.test/media/v1.mp4"),
            moment("gone", status: .hidden),
            moment("s1", kind: .video, url: "https://customer-abc.cloudflarestream.com/uid/iframe"),
        ], truncated: true, downloader: downloader, saver: saver)
        await subject.start()
        #expect(downloader.requested.map(\.lastPathComponent) == ["p1.jpg", "v1.mp4"])
        #expect(saver.saved == [.image, .video])
        #expect(subject.phase == .finished(.init(saved: 2, failed: 0, skippedVideos: 1, isTruncated: true, wasCancelled: false)))
        // Every temporary file is removed once saved.
        #expect(downloader.files.allSatisfy { !FileManager.default.fileExists(atPath: $0.path(percentEncoded: false)) })
    }

    @Test func oneBadFileIsCountedAndTheRestStillSave() async {
        let downloader = FakeDownloader()
        downloader.failing = ["p2.jpg"]
        let saver = FakeSaver()
        saver.errorAt = (1, URLError(.cannotWriteToFile))
        let subject = model([moment("p1"), moment("p2"), moment("p3"), moment("p4")], downloader: downloader, saver: saver)
        await subject.start()
        #expect(subject.phase == .finished(.init(saved: 2, failed: 2, skippedVideos: 0, isTruncated: false, wasCancelled: false)))
    }

    @Test func photosAccessDeniedStopsEverything() async {
        let downloader = FakeDownloader()
        let saver = FakeSaver()
        saver.errorAt = (0, MomentSavingError.accessDenied)
        let subject = model([moment("p1"), moment("p2")], downloader: downloader, saver: saver)
        await subject.start()
        #expect(subject.phase == .failed(.photosAccessDenied(saved: 0)))
        #expect(downloader.requested.count == 1)
        #expect(downloader.files.allSatisfy { !FileManager.default.fileExists(atPath: $0.path(percentEncoded: false)) })
    }

    @Test func accessDeniedLaterKeepsTheCountAlreadySaved() async {
        let saver = FakeSaver()
        saver.errorAt = (2, MomentSavingError.accessDenied)
        let subject = model([moment("p1"), moment("p2"), moment("p3")], saver: saver)
        await subject.start()
        #expect(subject.phase == .failed(.photosAccessDenied(saved: 2)))
    }

    @Test func onlyMediaFilesOnTheAPIOriginAreDownloaded() {
        let moments = [
            moment("ok"),
            moment("stream-path", url: "https://customer-abc.cloudflarestream.com/media/x.jpg"),
            moment("other-port", url: "https://moments.test:8443/media/x.jpg"),
            moment("plain-http", url: "http://moments.test/media/x.jpg"),
            moment("up", url: "https://moments.test/media/../admin/x"),
            moment("not-media", url: "https://moments.test/e/party"),
        ]
        let plan = EventDownloadModel.plan(moments, origin: origin)
        #expect(plan.files.map(\.url.lastPathComponent) == ["ok.jpg"])
        #expect(plan.skippedVideos == 5)
    }

    @Test func aURLSessionCancelCountsAsCancelledNotFailed() async {
        let downloader = FakeDownloader()
        downloader.failing = ["p2.jpg"]
        downloader.cancelOnFailure = true
        let subject = model([moment("p1"), moment("p2")], downloader: downloader)
        await subject.start()
        #expect(subject.phase == .finished(.init(saved: 1, failed: 0, skippedVideos: 0, isTruncated: false, wasCancelled: true)))
    }

    @Test func cancellingStopsAfterTheCurrentFileAndSaysSo() async {
        let saver = FakeSaver()
        saver.cancelAfter = 1
        let subject = model([moment("p1"), moment("p2"), moment("p3")], saver: saver)
        await subject.start()
        #expect(saver.saved.count == 1)
        #expect(subject.phase == .finished(.init(saved: 1, failed: 0, skippedVideos: 0, isTruncated: false, wasCancelled: true)))
    }

    @Test func aMissingEventOrAPlanProblemFailsBeforeSaving() async {
        let service = FakeHostService()
        service.momentsResult = .failure(MomentsAPIError.eventNotFound)
        let saver = FakeSaver()
        let gone = EventDownloadModel(
            eventID: "a", origin: origin, service: service, account: HostAccount(service: service, store: FlakyHostStore(session)),
            downloader: FakeDownloader(), saver: saver
        )
        await gone.start()
        #expect(gone.phase == .failed(.gone))

        service.momentsResult = .failure(MomentsAPIError.planRequired)
        await gone.start()
        #expect(gone.phase == .failed(.load(.planRequired)))
        #expect(saver.saved.isEmpty)
    }

    @Test func signedOutDoesNothing() async {
        let service = FakeHostService()
        let subject = EventDownloadModel(
            eventID: "a", origin: origin, service: service, account: HostAccount(service: service, store: FlakyHostStore()),
            downloader: FakeDownloader(), saver: FakeSaver()
        )
        await subject.start()
        #expect(subject.phase == .idle)
    }
}
