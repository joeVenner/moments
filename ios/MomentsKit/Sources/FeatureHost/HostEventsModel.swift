import Foundation
import MomentsAPI
import MomentsDomain
import Observation

/// The signed-in host's events, for the host home screen.
@MainActor @Observable
public final class HostEventsModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case loaded
        /// Couldn't load; the last list (if any) stays on screen.
        case failed(Failure)
    }

    public typealias Failure = HostLoadFailure

    public private(set) var events: [AdminEvent] = []
    public private(set) var isTruncated = false
    public private(set) var phase: Phase = .idle
    /// The host's hosting plan, nil when they have none (or it hasn't loaded).
    /// Fetched alongside the events and applied with them; a failure keeps
    /// the last one and never fails the list.
    public private(set) var plan: HostPlan?

    @ObservationIgnored private let service: any HostService
    @ObservationIgnored private let account: HostAccount

    public init(service: any HostService, account: HostAccount) {
        self.service = service
        self.account = account
    }

    public func load() async {
        guard phase != .loading else { return }
        account.refresh()
        guard account.currentToken() != nil else { return clear() }
        phase = .loading
        // Both requests start at once; the plan only lands with a list.
        // The plan carries the session it was asked with, so a plan that
        // answered before the host signed in again is never shown.
        async let planOutcome = account.run(logCategory: "host-plan", { [service] token in
            (token: token, plan: try await service.hostPlan(token: token))
        })
        let eventsOutcome = await account.run(logCategory: "host-events", { [service] in try await service.adminEvents(token: $0) })
        let plan = await planOutcome
        switch eventsOutcome {
        case let .success(list):
            events = list.events
            isTruncated = list.isTruncated
            phase = .loaded
            apply(plan)
        case .signedOut, .notFound:
            clear()
        case .cancelled:
            phase = events.isEmpty ? .idle : .loaded
        case let .failure(failure):
            phase = .failed(failure)
        }
    }

    private func apply(_ outcome: HostCallOutcome<(token: String, plan: HostPlan?)>) {
        switch outcome {
        case let .success(answer):
            plan = answer.token == account.currentToken() ? answer.plan : nil
        // The list's answer speaks for the session: a plan that saw an older
        // one signed out (the host signed in again meanwhile) only drops itself.
        case .signedOut: plan = nil
        case .notFound, .cancelled, .failure: break
        }
    }

    /// Forgets the list, e.g. right after a sign-out.
    public func reset() { clear() }

    private func clear() {
        events = []
        isTruncated = false
        plan = nil
        phase = .idle
    }
}
