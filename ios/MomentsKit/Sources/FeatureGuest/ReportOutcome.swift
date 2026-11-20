import Foundation
import MomentsAPI

/// What reporting a moment came to, for the viewer's message.
public enum ReportOutcome: Equatable, Sendable {
    /// Sent (or this guest had already reported it).
    case reported
    /// Hidden or deleted meanwhile.
    case gone
    /// Too many reports from this device for now.
    case busy
    /// The screen is over: the guest must join again, or the event lost
    /// access, was deleted or is no longer hosted. The viewer closes.
    case ended
    /// The guest left the screen before the answer.
    case cancelled
    /// Anything else (offline, server trouble): worth trying again.
    case failed

    init(_ error: any Error) {
        switch error {
        case is CancellationError: self = .cancelled
        case MomentsAPIError.momentNotFound: self = .gone
        case MomentsAPIError.rateLimited: self = .busy
        case MomentsAPIError.guestRequired, MomentsAPIError.accessRequired,
             MomentsAPIError.eventNotFound, MomentsAPIError.eventNotHosted:
            self = .ended
        default: self = .failed
        }
    }

    /// What the viewer says afterwards; nil when the screen is going away.
    public var message: LocalizedStringResource? {
        switch self {
        case .reported: "Thanks, the host will take a look."
        case .gone: "This moment is no longer here."
        case .busy: "Too many reports for now. Try again in a minute."
        case .failed: "Couldn't send the report. Try again."
        case .ended, .cancelled: nil
        }
    }
}
