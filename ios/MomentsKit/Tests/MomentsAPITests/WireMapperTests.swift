import Foundation
import Testing
@testable import MomentsAPI
import MomentsDomain

private let mapper = WireMapper(apiBaseURL: URL(string: "https://moments.test")!)!

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

@Suite struct WireMapperTests {
    @Test func mapsAnEvent() throws {
        let wire = try decode(Components.Schemas.EventResponse.self, Fixtures.event(accessMode: "private")).event
        let event = try mapper.event(wire)
        #expect(event.accessMode == .private)
        #expect(event.coverImageURL == "https://moments.test/media/events/e1/cover.jpg")
        #expect(event.createdAt == ServerDate.parse("2026-11-17 18:30:00"))
        #expect(event.effectivePurgeAfter == ServerDate.parse("2026-12-01 00:00:00"))
        #expect(event.areUploadsOpen)
    }

    @Test func refusesAnEventWithAnUnknownAccessMode() throws {
        let wire = try decode(Components.Schemas.EventResponse.self, Fixtures.event(accessMode: "friends")).event
        #expect(throws: MomentsAPIError.unexpectedResponse) { try mapper.event(wire) }
    }

    @Test func mapsAMomentAndResolvesMediaURLs() throws {
        let moment = try #require(mapper.moment(try decode(Components.Schemas.Moment.self, Fixtures.moment())))
        #expect(moment.media.url == "https://moments.test/media/events/e1/moments/m1.jpg")
        #expect(moment.media.thumbURL == "https://moments.test/media/events/e1/thumbs/m1.jpg")
        #expect(moment.hasReacted && moment.reactionCount == 2)
        #expect(moment.media.aspectRatio == 1.5)
    }

    @Test func keepsAbsoluteStreamURLs() throws {
        let url = "https://customer-abc.cloudflarestream.com/0123/manifest/video.m3u8"
        let moment = try #require(mapper.moment(try decode(Components.Schemas.Moment.self, Fixtures.moment(kind: "video", url: url))))
        #expect(moment.media.url == url)
        #expect(moment.media.kind == .video)
    }

    @Test(arguments: [
        "//evil.test/x.jpg", "javascript:alert(1)", "http://evil.test/x.jpg", "file:///etc/passwd", "relative.jpg",
        "https://evil.test/x.jpg", "https://moments.test@evil.test/x.jpg", "https://evil.test\\@moments.test/x.jpg",
        "/\\evil.test/x.jpg", "https://customer-a.cloudflarestream.com.evil.test/x",
        "https://customer-a.cloudflarestream.com:8443/x", "http://customer-a.cloudflarestream.com/x",
        "http://moments.test/media/x.jpg", "https://moments.test:8443/media/x.jpg",
    ])
    func refusesUnsafeURLs(_ url: String) {
        #expect(mapper.resolve(url) == nil)
    }

    @Test func dropsMomentsWhoseMediaURLIsRefused() throws {
        #expect(mapper.moment(try decode(Components.Schemas.Moment.self, Fixtures.moment(url: "https://evil.test/x.jpg"))) == nil)
    }

    @Test func skipsUnknownKindsAndBadDatesButKeepsThePage() throws {
        let page = try decode(Components.Schemas.FeedPage.self, """
            {"moments":[\(Fixtures.moment(id: "a", seq: 3)),\(Fixtures.moment(id: "b", seq: 2, kind: "hologram")),
             \(Fixtures.moment(id: "c", seq: 1, createdAt: "yesterday"))],"next_before":1,"cursor":9}
            """)
        let mapped = mapper.feedPage(page)
        #expect(mapped.moments.map(\.id) == ["a"])
        #expect(mapped.skippedCount == 2)
        #expect(mapped.nextBefore == 1 && mapped.cursor == 9)
    }

    @Test func reportsUnreadableChangesAsRemoved() throws {
        let changes = try decode(Components.Schemas.FeedChanges.self, """
            {"upserts":[\(Fixtures.moment(id: "a")),\(Fixtures.moment(id: "b", kind: "hologram"))],
             "removed":["z"],"cursor":12,"has_more":true}
            """)
        let mapped = mapper.feedChanges(changes)
        #expect(mapped.upserts.map(\.id) == ["a"])
        #expect(mapped.removed == ["z", "b"])
        #expect(mapped.cursor == 12 && mapped.hasMore)
    }

    @Test func originDropsThePath() throws {
        let local = try #require(WireMapper(apiBaseURL: URL(string: "http://localhost:5173/some/path")!))
        #expect(local.resolve("/media/x.jpg") == "http://localhost:5173/media/x.jpg")
        #expect(local.resolve("http://localhost:5173/media/x.jpg") != nil)
        #expect(local.resolve("http://localhost:9999/media/x.jpg") == nil)
        #expect(local.resolve("http://other.test/media/x.jpg") == nil)
    }

    @Test func acceptsSameOriginAbsoluteURLsAndDotSegmentsStayOnOrigin() {
        #expect(mapper.resolve("https://MOMENTS.test/media/x.jpg") != nil)
        #expect(mapper.resolve("/media/../x")?.hasPrefix("https://moments.test/") == true)
    }

    @Test func dropsUnsafeOptionalURLsButKeepsTheRow() throws {
        var json = Fixtures.moment()
        json = json.replacingOccurrences(of: "/media/events/e1/thumbs/m1.jpg", with: "https://evil.test/t.jpg")
        let moment = try #require(mapper.moment(try decode(Components.Schemas.Moment.self, json)))
        #expect(moment.media.thumbURL == nil)
    }

    @Test func refusesAnEventWithABadCreationDate() throws {
        let json = Fixtures.event().replacingOccurrences(of: #""created_at":"2026-11-17 18:30:00""#, with: #""created_at":"soon""#)
        let wire = try decode(Components.Schemas.EventResponse.self, json).event
        #expect(throws: MomentsAPIError.unexpectedResponse) { try mapper.event(wire) }
    }

    @Test func unreadableUpsertReplacesAnOlderReadableCopyInTheFeed() throws {
        var feed = FeedState()
        let first = mapper.feedPage(try decode(Components.Schemas.FeedPage.self,
            #"{"moments":[\#(Fixtures.moment(id: "a"))],"next_before":null,"cursor":1}"#))
        feed.replace(withFirstPage: first.moments, nextBefore: first.nextBefore, cursor: first.cursor)
        #expect(feed.moments.map(\.id) == ["a"])

        let hidden = mapper.feedChanges(try decode(Components.Schemas.FeedChanges.self,
            #"{"upserts":[\#(Fixtures.moment(id: "a", seq: 2, kind: "hologram"))],"removed":[],"cursor":2,"has_more":false}"#))
        #expect(hidden.skippedCount == 1)
        _ = feed.applyChanges(upserts: hidden.upserts, removed: hidden.removed, cursor: hidden.cursor, hasMore: hidden.hasMore)
        #expect(feed.moments.isEmpty)

        let back = mapper.feedChanges(try decode(Components.Schemas.FeedChanges.self,
            #"{"upserts":[\#(Fixtures.moment(id: "a", seq: 3))],"removed":[],"cursor":3,"has_more":false}"#))
        _ = feed.applyChanges(upserts: back.upserts, removed: back.removed, cursor: back.cursor, hasMore: back.hasMore)
        #expect(feed.moments.map(\.id) == ["a"])
    }

    @Test func refusesBaseURLsWithoutAHost() {
        #expect(WireMapper(apiBaseURL: URL(string: "file:///tmp")!) == nil)
    }
}
