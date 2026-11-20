import Foundation
import MomentsDomain
import Testing

@Suite struct EventAcceptsUploadsTests {
    private func event(open: Bool, archived: Bool) -> Event {
        let now = Date(timeIntervalSince1970: 1_000_000)
        return Event(
            id: "e1", slug: "party", title: "Party", type: "party", createdAt: now,
            archivedAt: archived ? now : nil, areUploadsOpen: open
        )
    }

    @Test func onlyAnOpenUnarchivedEventTakesUploads() {
        #expect(event(open: true, archived: false).acceptsUploads)
        #expect(!event(open: false, archived: false).acceptsUploads)
        #expect(!event(open: true, archived: true).acceptsUploads)
    }
}
