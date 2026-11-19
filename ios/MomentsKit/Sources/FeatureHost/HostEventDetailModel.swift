import Foundation
import MomentsAPI
import MomentsDomain
import Observation

/// One hosted event: its share links and analytics, for the detail screen.
@MainActor @Observable
public final class HostEventDetailModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case loaded
        /// The event no longer exists.
        case gone
        /// Couldn't load; the last detail (if any) stays on screen.
        case failed(HostLoadFailure)
    }

    public let eventID: String
    public private(set) var detail: AdminEventDetail?
    public private(set) var phase: Phase = .idle

    @ObservationIgnored private let service: any HostService
    @ObservationIgnored private let account: HostAccount

    public init(eventID: String, service: any HostService, account: HostAccount) {
        self.eventID = eventID
        self.service = service
        self.account = account
    }

    public func load() async {
        guard phase != .loading else { return }
        account.refresh()
        guard account.currentToken() != nil else { return clear() }
        phase = .loading
        let id = eventID
        let outcome = await account.run(logCategory: "host-event", notFound: .eventNotFound) {
            try await service.adminEvent(token: $0, id: id)
        }
        switch outcome {
        case let .success(detail):
            self.detail = detail
            phase = .loaded
        case .notFound:
            detail = nil
            phase = .gone
        case .signedOut:
            clear()
        case .cancelled:
            phase = detail == nil ? .idle : .loaded
        case let .failure(failure):
            phase = .failed(failure)
        }
    }

    private func clear() {
        detail = nil
        phase = .idle
    }
}
