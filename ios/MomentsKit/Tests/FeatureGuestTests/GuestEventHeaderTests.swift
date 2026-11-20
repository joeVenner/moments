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
        #expect(line.contains(closesAt.formatted(date: .abbreviated, time: .shortened)))
    }

    @Test func saysNothingWithoutAnEndOrOnceClosedOrArchived() {
        #expect(GuestEventHeader.sharingLine(event(closes: nil)) == nil)
        #expect(GuestEventHeader.sharingLine(event(open: false, closes: closesAt)) == nil)
        #expect(GuestEventHeader.sharingLine(event(archived: true, closes: closesAt)) == nil)
    }

    @Test func withCountsTheLineSaysMomentsGuestsAndWhenSharingCloses() throws {
        let when = closesAt.formatted(date: .abbreviated, time: .shortened)
        let stats = EventStats(momentCount: 128, guestCount: 46)
        #expect(GuestEventHeader.headerLine(event(closes: closesAt), stats: stats) == "128 moments · 46 guests · open until \(when)")
        // Closed or with no end: the counts alone.
        #expect(GuestEventHeader.headerLine(event(open: false, closes: closesAt), stats: stats) == "128 moments · 46 guests")
        #expect(GuestEventHeader.headerLine(event(closes: nil), stats: stats) == "128 moments · 46 guests")
    }

    @Test func withoutCountsTheSharingLineStaysAlone() throws {
        let when = closesAt.formatted(date: .abbreviated, time: .shortened)
        #expect(GuestEventHeader.headerLine(event(closes: closesAt), stats: nil) == "Sharing open until \(when)")
        #expect(GuestEventHeader.headerLine(event(closes: nil), stats: nil) == nil)
    }
}
