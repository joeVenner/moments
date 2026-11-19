import Foundation

/// An event as the host's list shows it.
public struct AdminEvent: Sendable, Hashable, Identifiable {
    public let event: Event
    /// Every moment, hidden ones included.
    public let momentCount: Int
    /// Guests currently in the event.
    public let participantCount: Int

    public var id: String { event.id }

    public init(event: Event, momentCount: Int, participantCount: Int) {
        self.event = event
        self.momentCount = momentCount
        self.participantCount = participantCount
    }
}

/// The host's events, newest first.
public struct AdminEventList: Sendable, Hashable {
    public let events: [AdminEvent]
    /// Older events were left out by the server's cap (500).
    public let isTruncated: Bool

    public init(events: [AdminEvent], isTruncated: Bool) {
        self.events = events
        self.isTruncated = isTruncated
    }
}
