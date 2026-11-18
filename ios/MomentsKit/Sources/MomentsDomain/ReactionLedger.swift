/// Optimistic heart bookkeeping shared by every list of moments (feed,
/// highlights). It owns the pending toggles; the list owns the moments and
/// passes them in.
///
/// Rules:
/// - A pending toggle is never overwritten by server rows; it is confirmed
///   or rolled back explicitly, and after confirmation it survives one more
///   sync (that sync may have been read before the request landed).
/// - The guest may toggle again while a request is in flight; the answer then
///   doesn't settle the moment and the caller sends the new intent (the
///   endpoints are idempotent, so the last one sent wins).
struct ReactionLedger: Sendable, Equatable {
    struct Snapshot: Sendable, Equatable {
        var hasReacted: Bool
        var reactionCount: Int

        init(hasReacted: Bool, reactionCount: Int) {
            self.hasReacted = hasReacted
            self.reactionCount = reactionCount
        }

        init(_ moment: Moment) {
            self.init(hasReacted: moment.hasReacted, reactionCount: moment.reactionCount)
        }
    }

    private struct Pending: Sendable, Equatable {
        /// What the server last reported, restored by a rollback.
        var server: Snapshot
        /// False while the request is in flight; true once confirmed.
        var isConfirmed = false
    }

    private var pending: [String: Pending] = [:]
    /// Ids that were already confirmed when the previous sync finished.
    private var confirmedAtLastSync: Set<String> = []

    func isPending(_ id: String) -> Bool { pending[id] != nil }

    func hasUnsent(_ id: String) -> Bool { pending[id]?.isConfirmed == false }

    mutating func setReacted(_ hasReacted: Bool, id: String, in moments: inout [Moment]) -> Bool {
        guard let index = moments.firstIndex(where: { $0.id == id }),
              moments[index].hasReacted != hasReacted else { return false }
        let server = pending[id]?.server ?? Snapshot(moments[index])
        pending[id] = Pending(server: server)
        // A new intent restarts the "outlive one sync" clock.
        confirmedAtLastSync.remove(id)
        moments[index].hasReacted = hasReacted
        moments[index].reactionCount = max(0, moments[index].reactionCount + (hasReacted ? 1 : -1))
        return true
    }

    mutating func discardUnsentIfUnchanged(_ id: String, in moments: inout [Moment]) -> Bool {
        guard let entry = pending[id], !entry.isConfirmed,
              let index = moments.firstIndex(where: { $0.id == id }),
              moments[index].hasReacted == entry.server.hasReacted else { return false }
        pending[id] = nil
        moments[index].reactionCount = entry.server.reactionCount
        return true
    }

    mutating func confirm(_ id: String, reacted: Bool, reactionCount: Int, in moments: inout [Moment]) -> Bool {
        guard pending[id] != nil, let index = moments.firstIndex(where: { $0.id == id }) else { return true }
        pending[id]?.server = Snapshot(hasReacted: reacted, reactionCount: reactionCount)
        guard moments[index].hasReacted == reacted else {
            // Shown relative to the server's count, toggled the guest's way.
            moments[index].reactionCount = max(0, reactionCount + (moments[index].hasReacted ? 1 : -1))
            return false
        }
        moments[index].reactionCount = reactionCount
        pending[id]?.isConfirmed = true
        confirmedAtLastSync.remove(id)
        return true
    }

    mutating func rollback(_ id: String, in moments: inout [Moment]) {
        guard let snapshot = pending.removeValue(forKey: id)?.server,
              let index = moments.firstIndex(where: { $0.id == id }) else { return }
        moments[index].hasReacted = snapshot.hasReacted
        moments[index].reactionCount = snapshot.reactionCount
    }

    /// The server's state learned elsewhere (another list's settled answer).
    /// Applies only when nothing is pending here, so local intent wins.
    mutating func applyServerState(_ id: String, reacted: Bool, reactionCount: Int, in moments: inout [Moment]) {
        guard pending[id] == nil, let index = moments.firstIndex(where: { $0.id == id }) else { return }
        moments[index].hasReacted = reacted
        moments[index].reactionCount = reactionCount
    }

    // MARK: - Syncs

    /// Toggles confirmed before the previous sync have outlived one sync, so
    /// this sync's server values apply to them.
    mutating func startSync() {
        for id in confirmedAtLastSync where pending[id]?.isConfirmed == true {
            pending[id] = nil
        }
    }

    mutating func finishSync() {
        confirmedAtLastSync = Set(pending.filter(\.value.isConfirmed).keys)
    }

    /// An incoming server row for a pending moment: remember the server's
    /// view for a rollback and keep the local toggle on the row.
    mutating func overlay(_ incoming: inout Moment, local: Snapshot?) {
        guard pending[incoming.id] != nil, let local else { return }
        pending[incoming.id]?.server = Snapshot(incoming)
        incoming.hasReacted = local.hasReacted
        incoming.reactionCount = local.reactionCount
    }

    mutating func forget(_ ids: Set<String>) {
        for id in ids { pending[id] = nil }
    }

    /// Before a full replace: keeps only toggles for moments still present.
    mutating func keepOnly(_ ids: Set<String>) {
        pending = pending.filter { ids.contains($0.key) }
        confirmedAtLastSync.formIntersection(ids)
    }
}
