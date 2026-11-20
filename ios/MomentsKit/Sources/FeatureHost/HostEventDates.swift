import Foundation
import MomentsDomain

/// What an event's Dates row tells its host: when uploads close (or
/// closed) and when everything is deleted. Decided here, worded by the app.
public enum HostEventDates: Equatable, Sendable {
    /// Guests can still share; either date may be unknown.
    case open(closesAt: Date?, deletesOn: Date?)
    /// Sharing has stopped. `closedAt` is only set when that time has passed,
    /// so a close that came early (e.g. the plan ended) never shows a future date.
    case closed(closedAt: Date?, deletesOn: Date?)
    case archived

    public init(_ event: Event, now: Date = Date()) {
        if event.archivedAt != nil {
            self = .archived
        } else if event.areUploadsOpen {
            self = .open(closesAt: event.effectiveUploadsCloseAt, deletesOn: event.effectivePurgeAfter)
        } else {
            let closeAt = event.effectiveUploadsCloseAt.flatMap { $0 <= now ? $0 : nil }
            self = .closed(closedAt: closeAt, deletesOn: event.effectivePurgeAfter)
        }
    }
}
