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
    /// Loaded after the events; a failure keeps the last one and never fails
    /// the list.
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
        switch await account.run(logCategory: "host-events", { try await service.adminEvents(token: $0) }) {
        case let .success(list):
            events = list.events
            isTruncated = list.isTruncated
            phase = .loaded
            await loadPlan()
        case .signedOut, .notFound:
            clear()
        case .cancelled:
            phase = events.isEmpty ? .idle : .loaded
        case let .failure(failure):
            phase = .failed(failure)
        }
    }

    private func loadPlan() async {
        switch await account.run(logCategory: "host-plan", { try await service.hostPlan(token: $0) }) {
        case let .success(value): plan = value
        case .signedOut: clear()
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
