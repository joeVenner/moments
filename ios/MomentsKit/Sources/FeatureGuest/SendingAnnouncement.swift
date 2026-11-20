/// What VoiceOver hears when an event's uploads start or stop sending (the
/// App Clip's sending line changes silently otherwise; the app's uploads go
/// on behind the event's screens).
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

extension SendingAnnouncement {
    /// What VoiceOver says, in the app and the App Clip.
    public var message: String {
        switch self {
        case .started: String(localized: "Sending your photos.")
        case .allSent: String(localized: "Your photos are sent.")
        case let .someFailed(count): String(localized: "\(count) photos couldn't be sent. Open Your uploads to try again.")
        }
    }
}

extension UploadProgressModel {
    public var sendingSnapshot: SendingAnnouncement.Snapshot {
        SendingAnnouncement.Snapshot(source: ObjectIdentifier(self), active: activeCount, failed: failedCount, done: doneCount)
    }
}
