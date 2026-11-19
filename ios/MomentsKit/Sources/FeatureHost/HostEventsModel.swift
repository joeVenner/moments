import Foundation
import MomentsAPI
import MomentsDomain
import Observation
import OSLog

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

    public enum Failure: Equatable, Sendable {
        case offline
        case appTooOld
        case failed
    }

    public private(set) var events: [AdminEvent] = []
    public private(set) var isTruncated = false
    public private(set) var phase: Phase = .idle

    @ObservationIgnored private let service: any HostService
    @ObservationIgnored private let account: HostAccount
    @ObservationIgnored private let logger = Logger(subsystem: "moments", category: "host-events")

    public init(service: any HostService, account: HostAccount) {
        self.service = service
        self.account = account
    }

    public func load() async {
        guard phase != .loading else { return }
        account.refresh()
        // A second pass only when the session changed during the first.
        for _ in 0..<2 {
            guard let token = account.currentToken() else { return clear() }
            phase = .loading
            if await load(with: token) { return }
        }
        clear()
    }

    /// False when the session changed while this was in flight.
    private func load(with token: String) async -> Bool {
        do {
            let list = try await service.adminEvents(token: token)
            // Signed out (or in again) meanwhile: drop the answer.
            guard account.currentToken() == token else { return false }
            events = list.events
            isTruncated = list.isTruncated
            phase = .loaded
        } catch is CancellationError {
            phase = events.isEmpty ? .idle : .loaded
        } catch MomentsAPIError.hostAuthRequired {
            account.sessionEnded(token: token)
            guard account.currentToken() == nil else { return false }
            clear()
        } catch {
            guard account.currentToken() == token else { return false }
            logger.notice("host events failed: \(String(describing: type(of: error)), privacy: .public)")
            phase = .failed(Self.failure(for: error))
        }
        return true
    }

    /// Forgets the list, e.g. right after a sign-out.
    public func reset() { clear() }

    private func clear() {
        events = []
        isTruncated = false
        phase = .idle
    }

    static func failure(for error: any Error) -> Failure {
        switch error as? MomentsAPIError {
        case .transport: .offline
        case .upgradeRequired: .appTooOld
        default: .failed
        }
    }
}
