import Foundation
import MomentsDomain
import Testing
@testable import FeatureGuest

@Suite struct GuestEventHeaderTests {
    private let closesAt = Date(timeIntervalSince1970: 1_797_000_000)

    private func event(open: Bool = true, archived: Bool = false, closes: Date?) -> Event {
        Event(
            id: "e", slug: "party", title: "Party", type: "Party", createdAt: Date(timeIntervalSince1970: 0),
            uploadsCloseAt: closes, archivedAt: archived ? closesAt : nil, areUploadsOpen: open
        )
    }

    @Test func anOpenEventSaysWhenSharingCloses() throws {
        let line = try #require(GuestEventHeader.sharingLine(event(closes: closesAt)))
        #expect(String(localized: line).contains(closesAt.formatted(date: .abbreviated, time: .shortened)))
    }

    @Test func saysNothingWithoutAnEndOrOnceClosedOrArchived() {
        #expect(GuestEventHeader.sharingLine(event(closes: nil)) == nil)
        #expect(GuestEventHeader.sharingLine(event(open: false, closes: closesAt)) == nil)
        #expect(GuestEventHeader.sharingLine(event(archived: true, closes: closesAt)) == nil)
    }
}
