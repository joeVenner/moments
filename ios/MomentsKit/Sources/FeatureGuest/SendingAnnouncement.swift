/// What VoiceOver hears when an event's uploads start or stop sending (the
/// App Clip's sending line changes silently otherwise). Decided here, worded
/// by the screen.
public enum SendingAnnouncement: Equatable, Sendable {
    /// Nothing was sending, now something is.
    case started
    /// Everything finished and something new was sent.
    case allSent
    /// Everything finished; this many items failed.
    case someFailed(Int)

    /// The counts it compares, from one progress model (`source`).
    public struct Snapshot: Equatable, Sendable {
        public let source: ObjectIdentifier
        public let active: Int
        public let failed: Int
        public let done: Int

        public init(source: ObjectIdentifier, active: Int, failed: Int, done: Int) {
            self.source = source
            self.active = active
            self.failed = failed
            self.done = done
        }
    }

    /// Nil when nothing is worth saying: another event's model, or items
    /// that only went away (removed, or dropped by leaving) without being
    /// sent.
    public static func change(from old: Snapshot, to new: Snapshot) -> SendingAnnouncement? {
        guard old.source == new.source else { return nil }
        if old.active == 0, new.active > 0 { return .started }
        guard old.active > 0, new.active == 0 else { return nil }
        if new.failed > 0 { return .someFailed(new.failed) }
        return new.done > old.done ? .allSent : nil
    }
}

extension UploadProgressModel {
    public var sendingSnapshot: SendingAnnouncement.Snapshot {
        SendingAnnouncement.Snapshot(source: ObjectIdentifier(self), active: activeCount, failed: failedCount, done: doneCount)
    }
}
