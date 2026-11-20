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
    /// Counts applied saves, so a fetch that started before one never puts
    /// the older event back on screen.
    @ObservationIgnored private var savesApplied = 0

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
        let savesBefore = savesApplied
        let outcome = await account.run(logCategory: "host-event", notFound: .eventNotFound) {
            try await service.adminEvent(token: $0, id: id)
        }
        switch outcome {
        case let .success(detail):
            // A save landed meanwhile: it's newer than this answer.
            if savesApplied == savesBefore { self.detail = detail }
            phase = .loaded
        case .notFound:
            detail = nil
            phase = .gone
        case .signedOut:
            clear()
        case .cancelled:
            phase = detail == nil ? .idle : .loaded
        case let .failure(failure):
            // A failure from before a save says nothing about the saved event.
            phase = savesApplied == savesBefore ? .failed(failure) : .loaded
        }
    }

    /// Shows the event as a save just returned it, without another fetch.
    public func apply(_ detail: AdminEventDetail) {
        guard detail.summary.event.id == eventID else { return }
        savesApplied += 1
        self.detail = detail
        phase = .loaded
    }

    private func clear() {
        detail = nil
        phase = .idle
    }
}
