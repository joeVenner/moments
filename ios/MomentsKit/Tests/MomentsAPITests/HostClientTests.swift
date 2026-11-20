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

private func adminEvent(
    id: String, slug: String, accessMode: String = "public", kind: String = "main", guestCap: String = "150",
    moments: Int = 3, guests: Int = 2
) -> String {
    """
    {"id":"\(id)","slug":"\(slug)","title":"Party","type":"Party","main_characters":null,"description":null,
     "cover_image_url":null,"created_at":"2026-11-17 18:30:00","starts_at":null,"expires_at":null,
     "uploads_close_at":null,"purge_after":null,"archived_at":null,"access_mode":"\(accessMode)",
     "uploads_open":true,"kind":"\(kind)","guest_cap":\(guestCap),"moment_count":\(moments),"participant_count":\(guests)}
    """
}

private func detail(eventURL: String = "https://moments.test/e/party", inviteURL: String? = nil, accessMode: String = "public") -> String {
    let invite = inviteURL.map { "\"\($0)\"" } ?? "null"
    return """
    {"event":\(adminEvent(id: "e1", slug: "party", accessMode: accessMode)),
     "share":{"event_url":"\(eventURL)","invite_url":\(invite)},
     "analytics":{"summary":{"total_moments":5,"hidden_moments":1,"videos":2,"photos":3,"storage_bytes":1048576,
                             "participants":4,"reactions":7},
                  "activity":[{"day":"2026-11-18","count":2},{"day":"2026-11-19","count":3}],
                  "upload_states":[{"status":"open","count":1}]}}
    """
}

private func adminMoment(id: String = "m1", status: String = "approved", kind: String = "image") -> String {
    """
    {"id":"\(id)","event_id":"e1","uploader_name":"Sara","caption":null,"created_at":"2026-11-17 18:30:00",
     "mime_type":"image/jpeg","size_bytes":2048,"moderation_status":"\(status)","reaction_count":4,
     "media":\(Fixtures.media(kind: kind, url: "/media/events/e1/moments/\(id).jpg?mv=sig"))}
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

    private func planJSON(state: String = "lapsed", readonlyUntil: String = #""2026-12-20 10:00:00""#) -> String {
        """
        {"plan":{"state":"\(state)","product_id":"host_150","guest_cap":150,"pending_product_id":null,
         "period_ends_at":"2026-11-30 10:00:00","test_window_ends_at":"2026-11-30 10:00:00","grace_ends_at":null,
         "readonly_until":\(readonlyUntil),"can_edit":false,"can_moderate":false,"can_download":true,
         "events_left":{"main":0,"test":0}}}
        """
    }

    @Test func readsTheHostPlanWithTheBearer() async throws {
        let stub = StubTransport(json: planJSON())
        let plan = try #require(try await client(stub).hostPlan(token: hostToken))
        #expect(plan.state == .lapsed && plan.productID == "host_150" && plan.guestCap == 150)
        #expect(plan.readonlyUntil == ServerDate.parse("2026-12-20 10:00:00") && plan.graceEndsAt == nil)
        #expect(!plan.canEdit && !plan.canModerate && plan.canDownload)
        #expect(plan.eventsLeft == HostPlan.EventsLeft(main: 0, test: 0))
        let request = try #require(stub.requests.first)
        #expect(request.request.path == "/admin/plan")
        #expect(request.request.headerFields[.authorization] == "Bearer \(hostToken)")
    }

    @Test func noPlanIsNil() async throws {
        let stub = StubTransport(json: #"{"plan":null}"#)
        #expect(try await client(stub).hostPlan(token: hostToken) == nil)
    }

    @Test(arguments: [("purged", #""2026-12-20 10:00:00""#), ("lapsed", #""soon""#)])
    func aPlanThisBuildCantReadIsAnError(_ state: String, _ readonlyUntil: String) async throws {
        let stub = StubTransport(json: planJSON(state: state, readonlyUntil: readonlyUntil))
        await #expect(throws: MomentsAPIError.unexpectedResponse) { _ = try await client(stub).hostPlan(token: hostToken) }
    }

    @Test(arguments: [("legacy", AdminEvent.Kind.legacy), ("operator", .operatorOwned), ("main", .main), ("test", .test)])
    func readsTheEventKind(_ wire: String, _ expected: AdminEvent.Kind) async throws {
        let stub = StubTransport(json: #"{"events":[\#(adminEvent(id: "e1", slug: "party", kind: wire))],"truncated":false}"#)
        #expect(try await client(stub).adminEvents(token: hostToken).events.first?.kind == expected)
    }

    @Test func readsTheGuestLimit() async throws {
        let stub = StubTransport(json: """
        {"events":[\(adminEvent(id: "e1", slug: "a", kind: "test", guestCap: "15")),\(adminEvent(id: "e2", slug: "b", kind: "legacy", guestCap: "null"))],
         "truncated":false}
        """)
        let events = try await client(stub).adminEvents(token: hostToken).events
        #expect(events.map(\.guestCap) == [15, nil])
    }

    @Test func anEventKindThisBuildCantReadShowsAsLegacy() async throws {
        let stub = StubTransport(json: """
        {"events":[\(adminEvent(id: "e1", slug: "party", kind: "trial")),\(adminEvent(id: "e2", slug: "odd"))],"truncated":false}
        """)
        let events = try await client(stub).adminEvents(token: hostToken).events
        #expect(events.map(\.id) == ["e1", "e2"] && events.first?.kind == .legacy)
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

    @Test func readsOneEventWithItsLinksAndAnalytics() async throws {
        let stub = StubTransport(json: detail(inviteURL: "https://moments.test/e/party?invite=abc", accessMode: "private"))
        let event = try await client(stub).adminEvent(token: hostToken, id: "e1")
        #expect(event.summary.id == "e1" && event.summary.momentCount == 3)
        #expect(event.share.eventURL.absoluteString == "https://moments.test/e/party")
        #expect(event.share.inviteURL?.absoluteString == "https://moments.test/e/party?invite=abc")
        #expect(event.analytics.totalMoments == 5 && event.analytics.hiddenMoments == 1 && event.analytics.reactions == 7)
        #expect(event.analytics.activity == [.init(day: "2026-11-18", count: 2), .init(day: "2026-11-19", count: 3)])
        let request = try #require(stub.requests.first)
        #expect(request.request.path == "/admin/events/e1")
        #expect(request.request.headerFields[.authorization] == "Bearer \(hostToken)")
    }

    @Test(arguments: [
        "https://evil.test/e/party", "http://moments.test/e/party", "/e/party",
        "https://customer-abc.cloudflarestream.com/e/party", "https://user@moments.test/e/party",
        "https://moments.test:8443/e/party", "https://moments.test.evil.com/e/party", "javascript:alert(1)",
        "/e/party?x=https://moments.test",
    ])
    func refusesShareLinksOffOurOrigin(_ link: String) async throws {
        await #expect(throws: MomentsAPIError.unexpectedResponse) {
            _ = try await client(StubTransport(json: detail(eventURL: link))).adminEvent(token: hostToken, id: "e1")
        }
        await #expect(throws: MomentsAPIError.unexpectedResponse) {
            _ = try await client(StubTransport(json: detail(inviteURL: link))).adminEvent(token: hostToken, id: "e1")
        }
    }

    @Test func aMissingEventIsEventNotFound() async throws {
        let stub = StubTransport(status: 404, json: #"{"error":"x","code":"event_not_found"}"#)
        await #expect(throws: MomentsAPIError.eventNotFound) { _ = try await client(stub).adminEvent(token: hostToken, id: "e1") }
        await #expect(throws: MomentsAPIError.eventNotFound) {
            _ = try await client(StubTransport(json: "{}")).adminEvent(token: hostToken, id: String(repeating: "x", count: 101))
        }
    }

    @Test func encodesTheEventIDAsOnePathSegment() async throws {
        let stub = StubTransport(json: detail())
        _ = try await client(stub).adminEvent(token: hostToken, id: "a/../b")
        #expect(try #require(stub.requests.first).request.path == "/admin/events/a%2F..%2Fb")
    }

    @Test func neverPrintsTheInviteLink() {
        let links = EventShareLinks(eventURL: URL(string: "https://moments.test/e/p")!, inviteURL: URL(string: "https://moments.test/e/p?invite=secret123")!)
        var dumped = ""
        dump(links, to: &dumped)
        for text in [String(describing: links), String(reflecting: links), "\(links)", dumped] {
            #expect(!text.contains("secret123"), "\(text)")
        }
    }

    @Test func listsAnEventsMomentsAndSkipsRowsItCantTrust() async throws {
        let stub = StubTransport(json: """
        {"moments":[\(adminMoment(id: "m1")),\(adminMoment(id: "m2", status: "hidden")),
          \(adminMoment(id: "m3", status: "pending")),\(adminMoment(id: "m4", kind: "audio"))],"truncated":true}
        """)
        let list = try await client(stub).adminMoments(token: hostToken, eventID: "e1")
        // An unknown status is never guessed as visible or hidden.
        #expect(list.moments.map(\.id) == ["m1", "m2"])
        #expect(list.moments.map(\.isHidden) == [false, true])
        #expect(list.isTruncated)
        let first = try #require(list.moments.first)
        #expect(first.reactionCount == 4 && first.sizeBytes == 2048)
        #expect(first.media.url == "https://moments.test/media/events/e1/moments/m1.jpg?mv=sig")
        let request = try #require(stub.requests.first)
        #expect(request.request.method == .get && request.request.path == "/admin/events/e1/moments")
        #expect(request.request.headerFields[.authorization] == "Bearer \(hostToken)")
    }

    @Test func hidesAMomentAndReturnsItAsSaved() async throws {
        let stub = StubTransport(json: #"{"moment":\#(adminMoment(id: "m1", status: "hidden"))}"#)
        let saved = try await client(stub).moderate(token: hostToken, momentID: "m1", status: .hidden)
        #expect(saved.id == "m1" && saved.isHidden)
        let request = try #require(stub.requests.first)
        #expect(request.request.method == .patch && request.request.path == "/admin/moments/m1")
        #expect(request.request.headerFields[.authorization] == "Bearer \(hostToken)")
        let body = try JSONSerialization.jsonObject(with: Data(try #require(request.body).utf8)) as? [String: String]
        #expect(body == ["status": "hidden"])
    }

    @Test func acceptsTheSavedStatusEvenWhenAnotherDeviceChangedIt() async throws {
        let stub = StubTransport(json: #"{"moment":\#(adminMoment(id: "m1", status: "approved"))}"#)
        let saved = try await client(stub).moderate(token: hostToken, momentID: "m1", status: .hidden)
        #expect(saved.status == .approved)
    }

    @Test(arguments: [
        #"{"moment":\#(adminMoment(id: "other", status: "hidden"))}"#,
        #"{"moment":\#(adminMoment(id: "m1", status: "pending"))}"#,
    ])
    func refusesASavedMomentThatDoesntMatch(_ json: String) async throws {
        await #expect(throws: MomentsAPIError.unexpectedResponse) {
            _ = try await client(StubTransport(json: json)).moderate(token: hostToken, momentID: "m1", status: .hidden)
        }
    }

    @Test func deletesAMomentWithTheBearer() async throws {
        let stub = StubTransport(status: 204, json: "")
        try await client(stub).deleteMoment(token: hostToken, momentID: "m1")
        let request = try #require(stub.requests.first)
        #expect(request.request.method == .delete && request.request.path == "/admin/moments/m1")
        #expect(request.request.headerFields[.authorization] == "Bearer \(hostToken)")
    }

    @Test(arguments: [
        (502, "media_delete_failed", MomentsAPIError.mediaDeleteFailed),
        (404, "moment_not_found", .momentNotFound),
        (401, "host_auth_required", .hostAuthRequired),
        (402, "plan_required", .planRequired),
    ])
    func mapsDeleteFailures(_ status: Int, _ code: String, _ expected: MomentsAPIError) async throws {
        let stub = StubTransport(status: status, json: #"{"error":"x","code":"\#(code)"}"#)
        await #expect(throws: expected) { try await client(stub).deleteMoment(token: hostToken, momentID: "m1") }
    }

    @Test func moderationNeverCallsWithAnImpossibleIDOrNoToken() async throws {
        let stub = StubTransport(json: "{}")
        let long = String(repeating: "x", count: 101)
        await #expect(throws: MomentsAPIError.eventNotFound) { _ = try await client(stub).adminMoments(token: hostToken, eventID: "") }
        await #expect(throws: MomentsAPIError.momentNotFound) { _ = try await client(stub).moderate(token: hostToken, momentID: long, status: .hidden) }
        await #expect(throws: MomentsAPIError.momentNotFound) { try await client(stub).deleteMoment(token: hostToken, momentID: "") }
        await #expect(throws: MomentsAPIError.hostAuthRequired) { try await client(stub).deleteMoment(token: "", momentID: "m1") }
        #expect(stub.requests.isEmpty)
    }

    private func jsonBody(_ request: StubTransport.Recorded) throws -> [String: String] {
        let object = try JSONSerialization.jsonObject(with: Data(try #require(request.body).utf8))
        return try #require(object as? [String: String])
    }

    @Test func createsAnEventWithZonedDatesAndTheBearer() async throws {
        let stub = StubTransport(status: 201, json: detail())
        let startsAt = try #require(ServerDate.parse("2026-12-05 17:00:00"))
        let details = EventDetails(title: "Party", type: "Wedding", mainCharacters: "Sara", startsAt: startsAt)
        let created = try await client(stub).createEvent(token: hostToken, details: details, endsAt: nil)
        #expect(created.summary.event.id == "e1")
        let request = try #require(stub.requests.first)
        #expect(request.request.method == .post && request.request.path == "/admin/events")
        #expect(request.request.headerFields[.authorization] == "Bearer \(hostToken)")
        // No end: the field is left out, never sent as an empty date.
        #expect(try jsonBody(request) == [
            "title": "Party", "type": "Wedding", "main_characters": "Sara", "starts_at": "2026-12-05T17:00:00Z",
        ])
    }

    @Test(arguments: [
        (429, "rate_limited", MomentsAPIError.rateLimited),
        (400, "invalid_request", .invalidRequest),
        (401, "host_auth_required", .hostAuthRequired),
    ])
    func mapsCreateFailures(_ status: Int, _ code: String, _ expected: MomentsAPIError) async throws {
        let stub = StubTransport(status: status, json: #"{"error":"x","code":"\#(code)"}"#)
        await #expect(throws: expected) {
            _ = try await client(stub).createEvent(token: hostToken, details: EventDetails(title: "P", type: "P"), endsAt: nil)
        }
    }

    @Test func editsAnEventSendingEmptyToClear() async throws {
        let stub = StubTransport(json: detail())
        _ = try await client(stub).updateEvent(token: hostToken, id: "e1", details: EventDetails(title: "Party", type: "Party"))
        let request = try #require(stub.requests.first)
        #expect(request.request.method == .patch && request.request.path == "/admin/events/e1")
        #expect(request.request.headerFields[.authorization] == "Bearer \(hostToken)")
        #expect(try jsonBody(request) == ["title": "Party", "type": "Party", "main_characters": "", "description": "", "starts_at": ""])
    }

    @Test func changesAccessAndLeavesThePINOutToKeepIt() async throws {
        let stub = StubTransport(json: detail(inviteURL: "https://moments.test/e/party?invite=abc", accessMode: "private"))
        _ = try await client(stub).updateAccess(token: hostToken, id: "e1", mode: .private, newPIN: nil)
        _ = try await client(stub).updateAccess(token: hostToken, id: "e1", mode: .private, newPIN: "482913")
        #expect(stub.requests.map(\.request.path) == ["/admin/events/e1/access", "/admin/events/e1/access"])
        #expect(try jsonBody(stub.requests[0]) == ["mode": "private"])
        #expect(try jsonBody(stub.requests[1]) == ["mode": "private", "pin": "482913"])
    }

    @Test func setsBothSplitDatesAndClearsTheSingleOne() async throws {
        let stub = StubTransport(json: detail())
        let close = try #require(ServerDate.parse("2026-12-05 17:00:00"))
        _ = try await client(stub).updateDates(token: hostToken, id: "e1", uploadsCloseAt: close, deleteAfter: nil)
        let request = try #require(stub.requests.first)
        #expect(request.request.method == .patch && request.request.path == "/admin/events/e1/lifecycle")
        #expect(try jsonBody(request) == ["uploads_close_at": "2026-12-05T17:00:00Z", "purge_after": "", "expires_at": ""])
    }

    @Test func refusesAnAnswerForAnotherEvent() async throws {
        let stub = StubTransport(json: detail())
        await #expect(throws: MomentsAPIError.unexpectedResponse) {
            _ = try await client(stub).updateEvent(token: hostToken, id: "other", details: EventDetails(title: "P", type: "P"))
        }
    }

    @Test func eventWritesNeverCallWithAnImpossibleIDOrNoToken() async throws {
        let stub = StubTransport(json: "{}")
        await #expect(throws: MomentsAPIError.eventNotFound) {
            _ = try await client(stub).updateAccess(token: hostToken, id: "", mode: .public, newPIN: nil)
        }
        await #expect(throws: MomentsAPIError.eventNotFound) {
            _ = try await client(stub).updateDates(token: hostToken, id: String(repeating: "x", count: 101), uploadsCloseAt: nil, deleteAfter: nil)
        }
        await #expect(throws: MomentsAPIError.hostAuthRequired) {
            _ = try await client(stub).createEvent(token: "", details: EventDetails(title: "P", type: "P"), endsAt: nil)
        }
        #expect(stub.requests.isEmpty)
    }

    @Test func aMissingEventsMomentsAreEventNotFound() async throws {
        let stub = StubTransport(status: 404, json: #"{"error":"x","code":"event_not_found"}"#)
        await #expect(throws: MomentsAPIError.eventNotFound) { _ = try await client(stub).adminMoments(token: hostToken, eventID: "e1") }
    }
}
