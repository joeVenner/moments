import Foundation
import HTTPTypes
import Testing
@testable import MomentsAPI
import MomentsDomain

private let base = URL(string: "https://moments.test")!
private let identity = ClientIdentity(version: "1.2.0", build: "42")
private let hostToken = "hs_" + String(repeating: "a", count: 43)

private func client(_ transport: StubTransport) throws -> MomentsClient {
    try MomentsClient(baseURL: base, identity: identity, transport: transport)
}

private func adminEvent(id: String, slug: String, accessMode: String = "public", moments: Int = 3, guests: Int = 2) -> String {
    """
    {"id":"\(id)","slug":"\(slug)","title":"Party","type":"Party","main_characters":null,"description":null,
     "cover_image_url":null,"created_at":"2026-11-17 18:30:00","starts_at":null,"expires_at":null,
     "uploads_close_at":null,"purge_after":null,"archived_at":null,"access_mode":"\(accessMode)",
     "uploads_open":true,"moment_count":\(moments),"participant_count":\(guests)}
    """
}

@Suite struct HostClientTests {
    @Test func signsInWithTheJSONBodyAndNoBearer() async throws {
        let stub = StubTransport(status: 201, json: """
        {"subject":"operator","expires_at":"2026-12-19 10:00:00","token":"\(hostToken)","token_type":"Bearer"}
        """)
        let session = try await client(stub).signIn(username: "admin", password: "pw")
        #expect(session.token == hostToken && session.subject == "operator")
        #expect(session.expiresAt == ServerDate.parse("2026-12-19 10:00:00"))
        let request = try #require(stub.requests.first)
        #expect(request.request.method == .post && request.request.path == "/admin/session")
        #expect(request.request.headerFields[.authorization] == nil)
        let body = try JSONSerialization.jsonObject(with: Data(try #require(request.body).utf8)) as? [String: String]
        #expect(body == ["username": "admin", "password": "pw"])
        // Never printed.
        #expect(!String(describing: session).contains(hostToken) && !String(reflecting: session).contains(hostToken))
    }

    @Test(arguments: [
        (401, "invalid_credentials", MomentsAPIError.invalidCredentials),
        (429, "rate_limited", .tooManyAttempts(retryAfterSeconds: 900)),
        (503, "sign_in_unavailable", .signInUnavailable),
        (426, "client_upgrade_required", .upgradeRequired),
        (400, "invalid_request", .invalidRequest),
    ])
    func mapsSignInFailures(_ status: Int, _ code: String, _ expected: MomentsAPIError) async throws {
        let stub = StubTransport(status: status, json: #"{"error":"x","code":"\#(code)"}"#)
        await #expect(throws: expected) { _ = try await client(stub).signIn(username: "admin", password: "pw") }
    }

    @Test func refusesEmptyCredentialsWithoutCalling() async throws {
        let stub = StubTransport(json: "{}")
        await #expect(throws: MomentsAPIError.invalidCredentials) { _ = try await client(stub).signIn(username: "", password: "pw") }
        #expect(stub.requests.isEmpty)
    }

    @Test func listsEventsWithTheBearerAndSkipsUnreadableRows() async throws {
        let stub = StubTransport(json: """
        {"events":[\(adminEvent(id: "e1", slug: "party", accessMode: "private")),\(adminEvent(id: "e2", slug: "odd", accessMode: "secret"))],
         "truncated":true}
        """)
        let list = try await client(stub).adminEvents(token: hostToken)
        #expect(list.isTruncated)
        #expect(list.events.map(\.id) == ["e1"])
        #expect(list.events.first?.momentCount == 3 && list.events.first?.participantCount == 2)
        #expect(list.events.first?.event.accessMode == .private)
        let request = try #require(stub.requests.first)
        #expect(request.request.path == "/admin/events")
        #expect(request.request.headerFields[.authorization] == "Bearer \(hostToken)")
    }

    @Test func aDeadSessionIsHostAuthRequiredNotEventAccess() async throws {
        let stub = StubTransport(status: 401, json: #"{"error":"x","code":"host_auth_required"}"#)
        await #expect(throws: MomentsAPIError.hostAuthRequired) { _ = try await client(stub).adminEvents(token: hostToken) }
        await #expect(throws: MomentsAPIError.hostAuthRequired) { _ = try await client(stub).hostSessionExpiry(token: hostToken) }
        await #expect(throws: MomentsAPIError.hostAuthRequired) { try await client(stub).signOut(token: hostToken) }
    }

    @Test func anEmptyTokenNeverCalls() async throws {
        let stub = StubTransport(json: "{}")
        await #expect(throws: MomentsAPIError.hostAuthRequired) { _ = try await client(stub).adminEvents(token: "") }
        #expect(stub.requests.isEmpty)
    }

    @Test func signsOutWithTheBearer() async throws {
        let stub = StubTransport(status: 204, json: "")
        try await client(stub).signOut(token: hostToken)
        let request = try #require(stub.requests.first)
        #expect(request.request.method == .delete && request.request.headerFields[.authorization] == "Bearer \(hostToken)")
    }

    @Test func readsTheSessionExpiry() async throws {
        let stub = StubTransport(json: #"{"subject":"operator","expires_at":"2026-12-19 10:00:00"}"#)
        let expiry = try await client(stub).hostSessionExpiry(token: hostToken)
        #expect(expiry == ServerDate.parse("2026-12-19 10:00:00"))
    }

    @Test func theBearerNeverRidesOnGuestRequests() async throws {
        let stub = StubTransport(json: Fixtures.event())
        let api = try client(stub)
        // Even inside a host token scope, a guest operation goes out without it.
        _ = try await HostAuthMiddleware.$token.withValue(hostToken) { try await api.event(slug: "party") }
        #expect(try #require(stub.requests.first).request.headerFields[.authorization] == nil)
    }
}
