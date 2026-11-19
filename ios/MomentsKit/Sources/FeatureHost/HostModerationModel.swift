import Foundation
import MomentsAPI
import MomentsDomain
import Observation

/// One event's moments for the host to hide, show again or delete.
@MainActor @Observable
public final class HostModerationModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case loaded
        /// The event no longer exists.
        case gone
        /// Couldn't load; the last list (if any) stays on screen.
        case failed(HostLoadFailure)
    }

    /// Why the last hide, show or delete didn't happen.
    public enum ActionFailure: Equatable, Sendable {
        case offline
        case appTooOld
        /// The moment's files couldn't be removed, so it was kept.
        case mediaKept
        case failed
    }

    public let eventID: String
    public private(set) var moments: [AdminMoment] = []
    public private(set) var isTruncated = false
    public private(set) var phase: Phase = .idle
    /// Moments with a hide, show or delete on its way.
    public var pendingIDs: Set<String> { Set(pendingActions.keys) }
    public private(set) var actionFailure: ActionFailure?

    /// Bumps whenever the list is replaced, so a late rollback can tell
    /// the row it would undo came from a newer load.
    @ObservationIgnored private var listVersion = 0
    /// Bumps when a hide, show or delete is confirmed, so a load that was
    /// already on its way doesn't bring the old state back.
    @ObservationIgnored private var confirmedActions = 0
    /// Bumps on `clear()`, so the answer of a load or action from before is dropped.
    @ObservationIgnored private var generation = 0
    /// One token per moment with an action on its way; only that action
    /// may clear it.
    private var pendingActions: [String: UUID] = [:]
    @ObservationIgnored private let service: any HostService
    @ObservationIgnored private let account: HostAccount

    public init(eventID: String, service: any HostService, account: HostAccount) {
        self.eventID = eventID
        self.service = service
        self.account = account
    }

    public var hiddenCount: Int { moments.count { $0.isHidden } }

    public func load() async {
        guard phase != .loading else { return }
        account.refresh()
        guard account.currentToken() != nil else { return clear() }
        phase = .loading
        let id = eventID
        let started = generation
        var outcome: HostCallOutcome<AdminMomentList> = .cancelled
        // At most twice: once more when an action was confirmed meanwhile.
        for _ in 0..<2 {
            let actionsBefore = confirmedActions
            outcome = await account.run(logCategory: "host-moderation", notFound: .eventNotFound) {
                try await service.adminMoments(token: $0, eventID: id)
            }
            guard generation == started else { return }
            if case .success = outcome, confirmedActions != actionsBefore { continue }
            break
        }
        switch outcome {
        case let .success(list):
            moments = list.moments
            isTruncated = list.isTruncated
            listVersion += 1
            phase = .loaded
        case .notFound:
            moments = []
            isTruncated = false
            phase = .gone
        case .signedOut:
            clear()
        case .cancelled:
            phase = moments.isEmpty ? .idle : .loaded
        case let .failure(failure):
            phase = .failed(failure)
        }
    }

    /// Hides the moment from guests (or shows it again) right away, and
    /// puts it back if the server says no.
    public func setHidden(_ isHidden: Bool, momentID: String) async {
        let target: AdminMoment.Status = isHidden ? .hidden : .approved
        guard let previous = moments.first(where: { $0.id == momentID })?.status, previous != target,
              let action = begin(momentID)
        else { return }
        defer { finish(momentID, action) }
        let version = listVersion
        let started = generation
        updateStatus(momentID, to: target)
        let outcome = await account.run(logCategory: "host-moderation", notFound: .momentNotFound) {
            try await service.moderate(token: $0, momentID: momentID, status: target)
        }
        guard generation == started else { return }
        switch outcome {
        case let .success(saved):
            // The server's answer wins, even if another device changed it too.
            if let index = moments.firstIndex(where: { $0.id == momentID }) { moments[index] = saved }
            confirmedActions += 1
        case .notFound:
            moments.removeAll { $0.id == momentID }
            confirmedActions += 1
        case .signedOut:
            clear()
        case .cancelled:
            rollBack(momentID, to: previous, ifListIs: version)
        case let .failure(failure):
            rollBack(momentID, to: previous, ifListIs: version)
            actionFailure = ActionFailure(failure)
        }
    }

    /// Deletes the moment and its files for good. It stays on screen until
    /// the server confirms.
    public func delete(momentID: String) async {
        guard moments.contains(where: { $0.id == momentID }), let action = begin(momentID) else { return }
        defer { finish(momentID, action) }
        let started = generation
        let outcome = await account.run(logCategory: "host-moderation", notFound: .momentNotFound) { token -> Bool in
            do {
                try await service.deleteMoment(token: token, momentID: momentID)
                return true
            } catch MomentsAPIError.mediaDeleteFailed {
                return false
            }
        }
        guard generation == started else { return }
        switch outcome {
        case .success(true), .notFound:
            moments.removeAll { $0.id == momentID }
            confirmedActions += 1
        case .success(false):
            actionFailure = .mediaKept
        case .signedOut:
            clear()
        case .cancelled:
            break
        case let .failure(failure):
            actionFailure = ActionFailure(failure)
        }
    }

    public func dismissActionFailure() { actionFailure = nil }

    /// Forgets everything, e.g. right after a sign-out.
    public func reset() { clear() }

    /// The action's token, or nil when signed out or one is already on its way.
    private func begin(_ momentID: String) -> UUID? {
        guard account.currentToken() != nil, pendingActions[momentID] == nil else { return nil }
        actionFailure = nil
        let action = UUID()
        pendingActions[momentID] = action
        return action
    }

    private func finish(_ momentID: String, _ action: UUID) {
        if pendingActions[momentID] == action { pendingActions[momentID] = nil }
    }

    private func updateStatus(_ momentID: String, to status: AdminMoment.Status) {
        guard let index = moments.firstIndex(where: { $0.id == momentID }) else { return }
        moments[index].status = status
    }

    /// Only undoes our own change: a reload meanwhile wins.
    private func rollBack(_ momentID: String, to previous: AdminMoment.Status, ifListIs version: Int) {
        guard version == listVersion, let index = moments.firstIndex(where: { $0.id == momentID }) else { return }
        moments[index].status = previous
    }

    private func clear() {
        moments = []
        isTruncated = false
        listVersion += 1
        generation += 1
        pendingActions = [:]
        actionFailure = nil
        phase = .idle
    }
}

extension HostModerationModel.ActionFailure {
    init(_ failure: HostLoadFailure) {
        switch failure {
        case .offline: self = .offline
        case .appTooOld: self = .appTooOld
        case .failed: self = .failed
        }
    }
}
