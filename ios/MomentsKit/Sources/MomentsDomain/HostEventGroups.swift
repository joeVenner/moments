import Foundation

/// The host's events sorted the way the Hosting tab shows them.
public struct HostEventGroups: Sendable, Equatable {
    /// Open for uploads and already started (or with no start date).
    public let live: [AdminEvent]
    /// Open for uploads but starting later; soonest first.
    public let upcoming: [AdminEvent]
    /// Archived or closed to uploads; in the server's order (newest first).
    public let past: [AdminEvent]

    public var isEmpty: Bool { live.isEmpty && upcoming.isEmpty && past.isEmpty }

    /// - Parameters:
    ///   - events: the server's list, newest first.
    ///   - now: the moment to judge "started" against.
    public init(events: [AdminEvent], now: Date) {
        var live: [AdminEvent] = []
        var upcoming: [(startsAt: Date, item: AdminEvent)] = []
        var past: [AdminEvent] = []
        for item in events {
            let event = item.event
            if !event.acceptsUploads {
                past.append(item)
            } else if let startsAt = event.startsAt, startsAt > now {
                upcoming.append((startsAt, item))
            } else {
                live.append(item)
            }
        }
        self.live = live
        // The id breaks ties so the order never flickers between reloads.
        self.upcoming = upcoming
            .sorted { ($0.startsAt, $0.item.id) < ($1.startsAt, $1.item.id) }
            .map(\.item)
        self.past = past
    }
}
