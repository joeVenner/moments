import Foundation
import Testing
@testable import MomentsDomain

private let now = Date(timeIntervalSince1970: 1_000_000)

private func item(
    _ id: String, startsIn: TimeInterval? = nil, isOpen: Bool = true, isArchived: Bool = false
) -> AdminEvent {
    let event = Event(
        id: id, slug: id, title: id, type: "party", createdAt: now.addingTimeInterval(-86_400),
        startsAt: startsIn.map { now.addingTimeInterval($0) },
        archivedAt: isArchived ? now.addingTimeInterval(-60) : nil, areUploadsOpen: isOpen
    )
    return AdminEvent(event: event, kind: .main, momentCount: 0, participantCount: 0)
}

@Suite struct HostEventGroupsTests {
    @Test func anEmptyListHasNoGroups() {
        #expect(HostEventGroups(events: [], now: now).isEmpty)
    }

    @Test func anOpenEventThatHasStartedIsLive() {
        let groups = HostEventGroups(events: [item("a", startsIn: -60), item("b")], now: now)
        #expect(groups.live.map(\.id) == ["a", "b"])
        #expect(groups.upcoming.isEmpty && groups.past.isEmpty)
    }

    @Test func anEventStartingExactlyNowIsLive() {
        #expect(HostEventGroups(events: [item("a", startsIn: 0)], now: now).live.map(\.id) == ["a"])
    }

    @Test func upcomingEventsAreSoonestFirst() {
        let groups = HostEventGroups(events: [item("late", startsIn: 7_200), item("soon", startsIn: 60)], now: now)
        #expect(groups.upcoming.map(\.id) == ["soon", "late"])
    }

    @Test func upcomingTiesKeepAStableOrder() {
        let groups = HostEventGroups(events: [item("b", startsIn: 60), item("a", startsIn: 60)], now: now)
        #expect(groups.upcoming.map(\.id) == ["a", "b"])
    }

    @Test func closedOrArchivedEventsArePastEvenIfTheyStartLater() {
        let groups = HostEventGroups(
            events: [item("closed", isOpen: false), item("archived", startsIn: 600, isArchived: true)], now: now
        )
        #expect(groups.past.map(\.id) == ["closed", "archived"])
        #expect(groups.live.isEmpty && groups.upcoming.isEmpty)
    }

    @Test func anArchivedEventStillOpenToUploadsIsPast() {
        #expect(HostEventGroups(events: [item("a", startsIn: -60, isArchived: true)], now: now).past.map(\.id) == ["a"])
    }

    @Test func pastKeepsTheServersOrderAmongOtherGroups() {
        let groups = HostEventGroups(
            events: [item("p1", isOpen: false), item("live"), item("p2", isArchived: true), item("up", startsIn: 60), item("p3", isOpen: false)],
            now: now
        )
        #expect(groups.past.map(\.id) == ["p1", "p2", "p3"])
        #expect(groups.live.map(\.id) == ["live"])
        #expect(groups.upcoming.map(\.id) == ["up"])
    }
}
