import Foundation
import MomentsDomain
import Testing
@testable import FeatureHost

@Suite struct HostEventDatesTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private var earlier: Date { now.addingTimeInterval(-3_600) }
    private var later: Date { now.addingTimeInterval(3_600) }
    private var purge: Date { now.addingTimeInterval(30 * 86_400) }

    private func event(open: Bool, closes: Date? = nil, purge: Date? = nil, archived: Bool = false) -> Event {
        Event(
            id: "e", slug: "party", title: "Party", type: "Party", createdAt: .distantPast,
            uploadsCloseAt: closes, purgeAfter: purge, archivedAt: archived ? now : nil, areUploadsOpen: open
        )
    }

    @Test func anOpenEventSaysWhenItClosesAndIsDeleted() {
        #expect(HostEventDates(event(open: true, closes: later, purge: purge), now: now) == .open(closesAt: later, deletesOn: purge))
    }

    @Test func aClosedEventSaysWhenItClosed() {
        #expect(HostEventDates(event(open: false, closes: earlier, purge: purge), now: now) == .closed(closedAt: earlier, deletesOn: purge))
    }

    @Test func aCloseRightNowCountsAsPassed() {
        #expect(HostEventDates(event(open: false, closes: now), now: now) == .closed(closedAt: now, deletesOn: nil))
    }

    @Test func anEarlyCloseNeverShowsAFutureTime() {
        #expect(HostEventDates(event(open: false, closes: later, purge: purge), now: now) == .closed(closedAt: nil, deletesOn: purge))
    }

    @Test func anArchivedEventIsJustArchived() {
        #expect(HostEventDates(event(open: false, closes: earlier, purge: purge, archived: true), now: now) == .archived)
        #expect(HostEventDates(event(open: true, closes: later, archived: true), now: now) == .archived)
    }

    @Test func unknownDatesStayUnknown() {
        #expect(HostEventDates(event(open: true), now: now) == .open(closesAt: nil, deletesOn: nil))
        #expect(HostEventDates(event(open: false), now: now) == .closed(closedAt: nil, deletesOn: nil))
    }
}
