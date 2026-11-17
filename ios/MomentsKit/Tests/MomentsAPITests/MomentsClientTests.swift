import Foundation
import HTTPTypes
import Testing
@testable import MomentsAPI
import MomentsDomain

private let base = URL(string: "https://moments.test")!
private let identity = ClientIdentity(version: "1.2.0", build: "42")

private func client(_ transport: StubTransport) throws -> MomentsClient {
    try MomentsClient(baseURL: base, identity: identity, transport: transport)
}

@Suite struct MomentsClientTests {
    @Test func sendsVersionAndGrantHeadersToTheV1Path() async throws {
        let stub = StubTransport(json: Fixtures.event())
        let event = try await client(stub).event(slug: "party", credentials: .init(accessGrant: "grant-1"))
        #expect(event.slug == "party")
        let request = try #require(stub.requests.first)
        #expect(request.baseURL.absoluteString == "https://moments.test/api/v1")
        #expect(request.request.path == "/events/party")
        #expect(request.request.headerFields[HTTPField.Name("X-Client")!] == "ios/1.2.0(42)")
        #expect(request.request.headerFields[HTTPField.Name("X-Event-Access")!] == "grant-1")
    }

    @Test func omitsCredentialHeadersWhenNotGiven() async throws {
        let stub = StubTransport(json: Fixtures.event())
        _ = try await client(stub).event(slug: "party")
        let fields = try #require(stub.requests.first).request.headerFields
        #expect(fields[HTTPField.Name("X-Event-Access")!] == nil)
        #expect(fields[HTTPField.Name("X-Guest-Token")!] == nil)
    }

    @Test func escapesTheSlugInThePath() async throws {
        let stub = StubTransport(json: Fixtures.event())
        _ = try await client(stub).event(slug: "a/b?c")
        #expect(try #require(stub.requests.first).request.path == "/events/a%2Fb%3Fc")
    }

    @Test func joinsWithBodyAndGuestToken() async throws {
        let stub = StubTransport(json: """
            {"participant":{"id":"p1","event_id":"e1","nickname":"Sara","avatar_seed":"s","joined_at":"2026-11-17 18:30:00"},
             "guest_token":"gt_abc"}
            """)
        let result = try await client(stub).join(
            slug: "party", nickname: "Sara", avatarSeed: "s", credentials: .init(guestToken: "gt_old")
        )
        #expect(result.guestToken == "gt_abc")
        #expect(result.participant.nickname == "Sara")
        let request = try #require(stub.requests.first)
        #expect(request.request.method == .post)
        #expect(request.request.headerFields[HTTPField.Name("X-Guest-Token")!] == "gt_old")
        let body = try JSONSerialization.jsonObject(with: Data(try #require(request.body).utf8)) as? [String: String]
        #expect(body == ["nickname": "Sara", "avatar_seed": "s"])
    }

    @Test func passesFeedQuery() async throws {
        let stub = StubTransport(json: #"{"moments":[],"next_before":null,"cursor":7}"#)
        let page = try await client(stub).feedPage(slug: "party", before: 10, limit: 30, reactorID: "me")
        #expect(page.cursor == 7 && page.nextBefore == nil && page.moments.isEmpty)
        let query = URLComponents(string: try #require(stub.requests.first?.request.path))?.queryItems ?? []
        #expect(Set(query) == [
            URLQueryItem(name: "before", value: "10"), URLQueryItem(name: "limit", value: "30"),
            URLQueryItem(name: "reactor_id", value: "me"),
        ])
    }

    @Test(arguments: [
        (401, "access_required", MomentsAPIError.accessRequired),
        (404, "event_not_found", .eventNotFound),
        (426, "client_upgrade_required", .upgradeRequired),
        (409, "nickname_taken", .nicknameTaken),
        (400, "invalid_request", .invalidRequest),
        (503, "stream_signing_unavailable", .server(status: 503, code: "stream_signing_unavailable")),
    ])
    func mapsErrorStatuses(_ status: Int, _ code: String, _ expected: MomentsAPIError) async throws {
        let stub = StubTransport(status: status, json: #"{"error":"x","code":"\#(code)"}"#)
        await #expect(throws: expected) {
            _ = try await client(stub).join(slug: "party", nickname: "Sara")
        }
    }

    @Test(arguments: [
        "http://moments.test", "https://user:pw@moments.test", "https://moments.test?x=1",
        "https://moments.test#f", "ftp://moments.test", "https://[::1]",
    ])
    func refusesUnsafeBaseURLs(_ url: String) {
        #expect(throws: MomentsClient.ConfigurationError.insecureBaseURL) {
            try MomentsClient(baseURL: URL(string: url)!, identity: identity, transport: StubTransport(json: "{}"))
        }
    }

    #if DEBUG
    @Test func allowsLocalhostOverHTTPInDebug() throws {
        _ = try MomentsClient(baseURL: URL(string: "http://localhost:5173")!, identity: identity, transport: StubTransport(json: "{}"))
    }
    #endif

    @Test func networkFailuresAreTypedAndNeverCarryCredentials() async throws {
        let stub = StubTransport(failure: URLError(.notConnectedToInternet))
        do {
            _ = try await client(stub).join(
                slug: "party", nickname: "Sara", credentials: .init(accessGrant: "grant-secret", guestToken: "gt_secret")
            )
            Issue.record("expected a failure")
        } catch {
            #expect(error as? MomentsAPIError == .transport(.notConnectedToInternet))
            let text = String(describing: error) + String(reflecting: error)
            #expect(!text.contains("grant-secret") && !text.contains("gt_secret"))
        }
    }

    @Test func cancellationStaysCancellation() async throws {
        await #expect(throws: CancellationError.self) {
            _ = try await client(StubTransport(failure: URLError(.cancelled))).event(slug: "party")
        }
        await #expect(throws: CancellationError.self) {
            _ = try await client(StubTransport(failure: CancellationError())).event(slug: "party")
        }
    }

    @Test func malformedBodiesAreUnexpectedResponses() async throws {
        await #expect(throws: MomentsAPIError.unexpectedResponse) {
            _ = try await client(StubTransport(json: #"{"moments":"nope"}"#)).feedPage(slug: "party")
        }
        await #expect(throws: MomentsAPIError.unexpectedResponse) {
            _ = try await client(StubTransport(json: "<html>", contentType: "text/html")).event(slug: "party")
        }
    }

    @Test func nonJSONErrorBodiesKeepTheStatus() async throws {
        let stub = StubTransport(status: 502, json: "<html>Bad gateway</html>", contentType: "text/html")
        await #expect(throws: MomentsAPIError.server(status: 502, code: nil)) {
            _ = try await client(stub).feedChanges(slug: "party", since: 0)
        }
    }

    @Test(arguments: [(401, MomentsAPIError.accessRequired), (404, .eventNotFound), (426, .upgradeRequired)])
    func mapsErrorsOnReads(_ status: Int, _ expected: MomentsAPIError) async throws {
        let codes = [401: "access_required", 404: "event_not_found", 426: "client_upgrade_required"]
        let json = #"{"error":"x","code":"\#(codes[status]!)"}"#
        await #expect(throws: expected) { _ = try await client(StubTransport(status: status, json: json)).event(slug: "p") }
        await #expect(throws: expected) { _ = try await client(StubTransport(status: status, json: json)).feedPage(slug: "p") }
    }

    @Test func fetchesChanges() async throws {
        let stub = StubTransport(json: """
            {"upserts":[\(Fixtures.moment(id: "a"))],"removed":["z"],"cursor":12,"has_more":true}
            """)
        let changes = try await client(stub).feedChanges(slug: "party", since: 5)
        #expect(changes.upserts.map(\.id) == ["a"] && changes.removed == ["z"] && changes.hasMore)
        #expect(try #require(stub.requests.first).request.path == "/events/party/feed/changes?since=5")
    }

    @Test func refusesRedirects() async throws {
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: URL(string: "https://moments.test")!)
        let response = HTTPURLResponse(url: URL(string: "https://moments.test")!, statusCode: 302, httpVersion: nil, headerFields: nil)!
        let next = await RedirectRefusal().urlSession(
            session, task: task, willPerformHTTPRedirection: response, newRequest: URLRequest(url: URL(string: "https://evil.test")!)
        )
        #expect(next == nil)
    }

    @Test(arguments: [
        ("1.2.0", "42", "ios/1.2.0(42)"), ("1.2.0-beta", "7", "ios/1.2.0(7)"), ("1.2.3.4", "7", "ios/1.2.3(7)"),
        ("v1", "7", "ios/0(7)"), ("12345.1", "7", "ios/0(7)"), ("2", "123456789", "ios/2(123456789)"),
    ])
    func headerMatchesTheServerFormat(_ version: String, _ build: String, _ expected: String) throws {
        // Same pattern as IOS_CLIENT in src/worker/v1/index.ts.
        let pattern = try Regex(#"^ios/\d{1,4}(?:\.\d{1,4}){0,2}\((\d{1,9})\)$"#)
        let value = ClientIdentity(version: version, build: build).headerValue
        #expect(value == expected)
        #expect(value.wholeMatch(of: pattern) != nil)
    }

    @Test func normalisesBadBuildNumbersWithoutCrashingReleaseBuilds() {
        // assertionFailure only fires in debug; check the release fallback directly.
        #expect(ClientIdentity.normalizedVersion("") == "0")
        #expect(ClientIdentity.normalizedVersion("1..2") == "0")
    }
}
