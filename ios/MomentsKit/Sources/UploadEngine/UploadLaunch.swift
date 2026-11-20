import Foundation

/// What the app does with the upload queue at launch, before running it.
public enum UploadLaunch {
    public struct Report: Sendable, Equatable {
        /// The saved queue was read (nil: it couldn't be; nothing runs).
        public let loaded: QueueStore.Loaded?
        /// Orphaned item folders removed (nil: the sweep was skipped).
        public let swept: Int?
        /// What was taken over from the App Clip (nil: nothing was tried).
        public let adoption: Adoption?

        public init(loaded: QueueStore.Loaded?, swept: Int?, adoption: Adoption? = nil) {
            self.loaded = loaded
            self.swept = swept
            self.adoption = adoption
        }
    }

    /// The queue the App Clip left in the App Group, and how to tell whether
    /// this device holds a guest for each record's event.
    public struct ClipQueue: Sendable {
        public let folders: UploadFolders
        public let credentials: UploadQueue.CredentialsLookup
        /// A record with no guest for its event is kept (not adopted) while
        /// younger than this: its guest may still arrive (a handover that
        /// couldn't be read this time). Use the handover window.
        public let strangersKeptFor: TimeInterval
        public let now: Date

        public init(
            folders: UploadFolders, strangersKeptFor: TimeInterval, now: Date = .now,
            credentials: @escaping UploadQueue.CredentialsLookup
        ) {
            self.folders = folders
            self.strangersKeptFor = strangersKeptFor
            self.now = now
            self.credentials = credentials
        }
    }

    public struct Adoption: Sendable, Equatable {
        /// Two attempts' counts (`retrying` adopts again after a failed load).
        static func + (lhs: Adoption, rhs: Adoption) -> Adoption {
            Adoption(
                moved: .init(
                    adopted: lhs.moved.adopted + rhs.moved.adopted, skipped: rhs.moved.skipped,
                    discarded: lhs.moved.discarded + rhs.moved.discarded
                ),
                dropped: lhs.dropped + rhs.dropped
            )
        }

        public var moved: QueueAdoption.Report
        /// Deleted with their files: no guest for the event on this device
        /// (it could never upload), or a record that can never be read.
        public var dropped: Int

        public init(moved: QueueAdoption.Report = .init(), dropped: Int = 0) {
            self.moved = moved
            self.dropped = dropped
        }
    }

    /// Loads the queue (which first picks up the background session's
    /// running tasks), then deletes staged folders no saved record owns:
    /// files prepared by a run that ended before queueing them. The sweep
    /// keeps every record on disk, loaded or not, and only folders from
    /// before `launchedAt`; if the records can't be listed it is skipped.
    ///
    /// First, with `clip`, it takes over the App Clip's leftover queue
    /// (`adoptClipQueue`), so those items load with the rest.
    public static func prepare(
        queue: UploadQueue, store: QueueStore, staging: StagingArea, launchedAt: Date, adopting clip: ClipQueue? = nil
    ) async -> Report {
        var adoption: Adoption?
        if let clip { adoption = await adoptClipQueue(clip, into: store, staging: staging) }
        let loaded: QueueStore.Loaded
        do {
            loaded = try await queue.load()
        } catch {
            return Report(loaded: nil, swept: nil, adoption: adoption)
        }
        guard let owners = try? store.recordIDs() else { return Report(loaded: loaded, swept: nil, adoption: adoption) }
        let swept = try? staging.sweepItemFolders(keeping: owners, createdBefore: launchedAt)
        return Report(loaded: loaded, swept: swept, adoption: adoption)
    }

    /// Moves the App Clip's records and files into this queue, only for
    /// events this device holds a guest for: the records come from a shared
    /// folder and name their own event. A record for any other event is
    /// deleted once older than `strangersKeptFor` (it could never upload),
    /// as is one that can never be read. A record that can't be checked now
    /// (unreadable, the keychain locked) or a younger stranger stays for a
    /// later launch. Nil when the Clip's folder can't be listed.
    static func adoptClipQueue(_ clip: ClipQueue, into store: QueueStore, staging: StagingArea) async -> Adoption? {
        let source = clip.folders
        guard let ids = try? source.store.recordIDs() else { return nil }
        var admitted = Set<UUID>()
        var dropped = 0
        var guests: [String: Guest] = [:]
        for id in ids {
            let item: QueuedUpload
            switch source.store.read(source.store.recordURL(for: id)) {
            case let .item(read): item = read
            case .unusable:
                if drop(id, from: source) { dropped += 1 }
                continue
            case .notNow, .gone: continue
            }
            let guest: Guest
            if let known = guests[item.eventSlug] {
                guest = known
            } else {
                guest = Guest(await clip.credentials(item.eventSlug))
                guests[item.eventSlug] = guest
            }
            switch guest {
            case .present: admitted.insert(id)
            case .absent where clip.now.timeIntervalSince(item.createdAt) > clip.strangersKeptFor:
                if drop(id, from: source) { dropped += 1 }
            case .absent, .unknown: continue
            }
        }
        guard let moved = try? QueueAdoption.adopt(
            from: source.store, staging: source.staging, into: store, staging: staging, admitting: admitted
        ) else { return Adoption(dropped: dropped) }
        return Adoption(moved: moved, dropped: dropped)
    }

    /// Whether this device holds a guest for an event.
    private enum Guest {
        case present, absent
        /// Can't tell now (the keychain locked).
        case unknown

        init(_ answer: CredentialsLookupResult) {
            switch answer {
            case .found: self = .present
            case .missing: self = .absent
            case .unavailable: self = .unknown
            }
        }
    }

    /// The record only: `QueueAdoption.adopt` then purges its folder, as
    /// one no record owns.
    private static func drop(_ id: UUID, from source: UploadFolders) -> Bool {
        (try? source.store.remove(id: id)) != nil
    }

    /// Runs `attempt` until the queue loads, waiting `delays` between tries:
    /// a read that failed in passing (an I/O error) gets another chance
    /// before sharing reports a failure. The last report either way.
    public static func retrying(
        after delays: [Duration] = [.seconds(1), .seconds(3)],
        sleep: @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
        _ attempt: @Sendable () async -> Report
    ) async -> Report {
        var report = await attempt()
        for delay in delays where report.loaded == nil {
            await sleep(delay)
            let next = await attempt()
            // An earlier attempt's adoption already happened: keep its counts.
            let adoption = switch (report.adoption, next.adoption) {
            case let (earlier?, later?): earlier + later
            case let (earlier, later): later ?? earlier
            }
            report = Report(loaded: next.loaded, swept: next.swept, adoption: adoption)
        }
        return report
    }
}
