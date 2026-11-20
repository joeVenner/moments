import Foundation
import Testing
@testable import MomentsAPI

/// Records requests and serves a scripted answer from a fresh temporary file.
private final class FetchScript: @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [URLRequest] = []
    private var _sources: [URL] = []
    var status = 200
    var error: Error?
    var requests: [URLRequest] { lock.withLock { _requests } }
    var sources: [URL] { lock.withLock { _sources } }

    func fetch(_ request: URLRequest) throws -> (URL, URLResponse) {
        lock.withLock { _requests.append(request) }
        if let error { throw error }
        let file = FileManager.default.temporaryDirectory.appending(path: "fetch-\(UUID().uuidString)")
        try Data("bytes".utf8).write(to: file)
        lock.withLock { _sources.append(file) }
        return (file, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

private func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) }

@Suite struct MediaFileDownloaderTests {
    private let directory = FileManager.default.temporaryDirectory.appending(path: "downloads-\(UUID().uuidString)")

    private func downloader(_ script: FetchScript) throws -> MediaFileDownloader {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return try MediaFileDownloader(
            baseURL: URL(string: "https://moments-hq.com")!, identity: ClientIdentity(version: "1.0", build: "7"),
            directory: directory
        ) { request in try script.fetch(request) }
    }

    private func leftovers() -> [URL] {
        (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
    }

    @Test func savesAnOriginFileWithItsExtensionAndSendsNoCredentials() async throws {
        let script = FetchScript()
        let subject = try downloader(script)
        let file = try await subject.download(URL(string: "https://moments-hq.com/media/e1/clip.MOV?mv=sig")!)
        defer { try? FileManager.default.removeItem(at: directory) }
        #expect(file.deletingLastPathComponent().standardizedFileURL == directory.standardizedFileURL)
        #expect(file.pathExtension == "mov")
        #expect(try Data(contentsOf: file) == Data("bytes".utf8))
        #expect(script.sources.allSatisfy { !exists($0) })
        let request = try #require(script.requests.first)
        #expect(request.value(forHTTPHeaderField: "X-Client") != nil)
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(request.value(forHTTPHeaderField: "X-Event-Access") == nil)
    }

    @Test(arguments: [
        "https://customer-abc.cloudflarestream.com/media/x.jpg",
        "https://moments-hq.com:8443/media/x.jpg",
        "http://moments-hq.com/media/x.jpg",
        "https://user@moments-hq.com/media/x.jpg",
        "https://evil.test/media/x.jpg",
    ])
    func nothingOffTheOriginIsFetched(link: String) async throws {
        let script = FetchScript()
        let subject = try downloader(script)
        defer { try? FileManager.default.removeItem(at: directory) }
        await #expect(throws: MomentsAPIError.invalidRequest) { try await subject.download(URL(string: link)!) }
        #expect(script.requests.isEmpty)
    }

    @Test(arguments: [(401, MomentsAPIError.accessRequired), (404, .eventNotFound), (500, .server(status: 500, code: nil))])
    func anErrorStatusLeavesNoFile(status: Int, expected: MomentsAPIError) async throws {
        let script = FetchScript()
        script.status = status
        let subject = try downloader(script)
        defer { try? FileManager.default.removeItem(at: directory) }
        await #expect(throws: expected) { try await subject.download(URL(string: "https://moments-hq.com/media/x.jpg")!) }
        #expect(script.sources.allSatisfy { !exists($0) })
        #expect(leftovers().isEmpty)
    }

    @Test func aCancelledTransferIsACancellationAndOtherFailuresAreTransport() async throws {
        let script = FetchScript()
        let subject = try downloader(script)
        defer { try? FileManager.default.removeItem(at: directory) }
        script.error = URLError(.cancelled)
        await #expect(throws: CancellationError.self) { try await subject.download(URL(string: "https://moments-hq.com/media/x.jpg")!) }
        script.error = URLError(.timedOut)
        await #expect(throws: MomentsAPIError.transport(.timedOut)) {
            try await subject.download(URL(string: "https://moments-hq.com/media/x.jpg")!)
        }
    }

    @Test func extensionsAreShortAndPlain() {
        #expect(MediaFileDownloader.safeExtension("JPG") == "jpg")
        #expect(MediaFileDownloader.safeExtension("mp4") == "mp4")
        #expect(MediaFileDownloader.safeExtension("") == nil)
        #expect(MediaFileDownloader.safeExtension("verylong") == nil)
        #expect(MediaFileDownloader.safeExtension("j%2F") == nil)
    }
}
