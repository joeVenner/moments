import Foundation
import MomentsDomain

/// The one-line status the Hosting card shows for a plan.
public enum HostPlanStatus: Equatable, Sendable {
    /// Paid and renewing on this date.
    case renews(Date)
    /// Paid until this date, won't renew.
    case ends(Date)
    /// A payment failed; Apple is retrying (with or without grace).
    case paymentFailed
    /// Hosting ended; the host can download until this date (nil: already over).
    case ended(downloadUntil: Date?)

    public init(_ plan: HostPlan) {
        switch plan.state {
        case .active: self = .renews(plan.periodEndsAt)
        case .canceling: self = .ends(plan.periodEndsAt)
        case .grace, .billingRetry: self = .paymentFailed
        case .lapsed, .revoked: self = .ended(downloadUntil: plan.canDownload ? plan.readonlyUntil : nil)
        }
    }
}

public extension HostPlan {
    /// Events the host can create now, or nil when the plan doesn't allow
    /// creating (then "0 left" would suggest buying more would help).
    var creatableEventCount: Int? {
        canEdit ? eventsLeft.main + eventsLeft.test : nil
    }
}
