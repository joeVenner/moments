import Foundation
import MomentsAPI
import MomentsDomain

/// A screen model that owns a list with optimistic hearts.
@MainActor
protocol ReactionHost: AnyObject {
    associatedtype List: ReactionList
    var reactionList: List { get set }
    /// Whether new toggles are accepted (the screen is loaded).
    var acceptsReactions: Bool { get }
    func sendReaction(_ reacted: Bool, momentID: String) async throws -> ReactionState
    /// The list changed (recompute what the screen shows).
    func reactionListDidChange()
    /// The server confirmed this device's state for a moment.
    func reactionDidSettle(momentID: String, state: ReactionState)
    /// A request failed; the toggle is already rolled back.
    func reactionDidFail(momentID: String, error: any Error)
}

/// One sender per moment: it keeps sending the guest's latest intent until
/// the server agrees, so rapid taps settle on the last one.
@MainActor
final class ReactionSenders<Host: ReactionHost> {
    /// Requests one moment's sender may make before giving up (each answer
    /// that doesn't settle costs one; guards against a misbehaving server).
    static var maxRequests: Int { 5 }

    enum SendError: Error {
        /// The server answered with the opposite of what was asked.
        case mismatchedAnswer
        case tooManyRequests
    }

    private weak var host: Host?
    private var tasks: [String: Task<Void, Never>] = [:]

    init(host: Host) {
        self.host = host
    }

    /// Hearts or un-hearts at once; the request follows.
    @discardableResult
    func setReacted(_ reacted: Bool, onMomentID id: String) -> Task<Void, Never>? {
        guard let host, host.acceptsReactions, host.reactionList.setReacted(reacted, forMomentID: id) else { return tasks[id] }
        host.reactionListDidChange()
        if let running = tasks[id] { return running }
        let task = Task { [weak self] in
            await self?.send(forMomentID: id)
            self?.tasks[id] = nil
        }
        tasks[id] = task
        return task
    }

    @discardableResult
    func toggle(onMomentID id: String) -> Task<Void, Never>? {
        guard let moment = host?.reactionList.moments.first(where: { $0.id == id }) else { return nil }
        return setReacted(!moment.hasReacted, onMomentID: id)
    }

    /// The screen is over (access lost, event gone).
    func cancelAll() {
        for task in tasks.values { task.cancel() }
    }

    /// No request is in flight at the top of the loop, so the server's last
    /// known state is the pending snapshot.
    private func send(forMomentID id: String) async {
        var requests = 0
        while let host, host.reactionList.hasUnsentReaction(forMomentID: id),
              !host.reactionList.discardUnsentReactionIfUnchanged(forMomentID: id),
              let wanted = host.reactionList.moments.first(where: { $0.id == id })?.hasReacted {
            do {
                guard requests < Self.maxRequests else { throw SendError.tooManyRequests }
                requests += 1
                let state = try await host.sendReaction(wanted, momentID: id)
                guard state.reacted == wanted else { throw SendError.mismatchedAnswer }
                let settled = host.reactionList.confirmReaction(
                    forMomentID: id, reacted: state.reacted, reactionCount: state.reactionCount
                )
                host.reactionListDidChange()
                if settled {
                    host.reactionDidSettle(momentID: id, state: state)
                    return
                }
            } catch {
                host.reactionList.rollbackReaction(forMomentID: id)
                host.reactionListDidChange()
                host.reactionDidFail(momentID: id, error: error)
                return
            }
        }
        host?.reactionListDidChange()
    }
}
