import Foundation
import Testing
@testable import MomentsAPI

private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    func append(_ request: URLRequest) { lock.withLock { requests.append(request) } }
    var all: [URLRequest] { lock.withLock { requests } }
}

private func fetcher(status: Int = 200, body: Data = Data("img".utf8), recorder: Recorder) throws -> MediaFetcher {
    try MediaFetcher(baseURL: URL(string: "https://moments-hq.com")!, identity: ClientIdentity(version: "1.0", build: "7")) { request, _ in
        recorder.append(request)
        return (body, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

@Suite struct MediaFetcherTests {
    @Test func grantGoesOnlyToOurOrigin() async throws {
        let recorder = Recorder()
        let media = try fetcher(recorder: recorder)
        _ = try await media.data(for: URL(string: "https://moments-hq.com/media/a.jpg")!, accessGrant: "grant")
        _ = try await media.data(for: URL(string: "https://customer-abc.cloudflarestream.com/u/thumbnails/t.jpg")!, accessGrant: "grant")
        _ = try await media.data(for: URL(string: "https://moments-hq.com:8443/media/a.jpg")!, accessGrant: "grant")
        let requests = recorder.all
        #expect(requests[0].value(forHTTPHeaderField: "X-Event-Access") == "grant")
        #expect(requests[1].value(forHTTPHeaderField: "X-Event-Access") == nil)
        #expect(requests[2].value(forHTTPHeaderField: "X-Event-Access") == nil)
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "X-Client") == "ios/1.0(7)" })
    }

    @Test func plainHTTPElsewhereIsRefused() async throws {
        let recorder = Recorder()
        let media = try fetcher(recorder: recorder)
        await #expect(throws: MomentsAPIError.invalidRequest) {
            _ = try await media.data(for: URL(string: "http://example.com/a.jpg")!, accessGrant: "grant")
        }
        #expect(recorder.all.isEmpty)
    }

    @Test(arguments: [(401, MomentsAPIError.accessRequired), (403, .accessRequired), (404, .eventNotFound), (500, .server(status: 500, code: nil))])
    func statusesAreTyped(_ status: Int, _ expected: MomentsAPIError) async throws {
        let media = try fetcher(status: status, recorder: Recorder())
        await #expect(throws: expected) {
            _ = try await media.data(for: URL(string: "https://moments-hq.com/media/a.jpg")!, accessGrant: nil)
        }
    }

    @Test func oversizedBodiesAreRefused() async throws {
        let media = try fetcher(body: Data(count: MediaFetcher.maxBytes + 1), recorder: Recorder())
        await #expect(throws: MomentsAPIError.unexpectedResponse) {
            _ = try await media.data(for: URL(string: "https://moments-hq.com/media/a.jpg")!, accessGrant: nil)
        }
    }

    @Test func aSmallerCapCanBeAskedFor() async throws {
        let media = try fetcher(body: Data(count: 2048), recorder: Recorder())
        await #expect(throws: MomentsAPIError.unexpectedResponse) {
            _ = try await media.data(for: URL(string: "https://moments-hq.com/media/a.jpg")!, accessGrant: nil, maxBytes: 1024)
        }
    }

    @Test func insecureBaseURLIsRefused() {
        #expect(throws: MomentsClient.ConfigurationError.insecureBaseURL) {
            _ = try MediaFetcher(baseURL: URL(string: "http://moments-hq.com")!, identity: ClientIdentity(version: "1", build: "1"))
        }
    }
}
