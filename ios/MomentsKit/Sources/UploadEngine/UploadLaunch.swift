import Foundation

/// What the app does with the upload queue at launch, before running it.
public enum UploadLaunch {
    public struct Report: Sendable, Equatable {
        /// The saved queue was read (nil: it couldn't be; nothing runs).
        public let loaded: QueueStore.Loaded?
        /// Orphaned item folders removed (nil: the sweep was skipped).
        public let swept: Int?
    }

    /// Loads the queue (which first picks up the background session's
    /// running tasks), then deletes staged folders no saved record owns:
    /// files prepared by a run that ended before queueing them. The sweep
    /// keeps every record on disk, loaded or not, and only folders from
    /// before `launchedAt`; if the records can't be listed it is skipped.
    public static func prepare(
        queue: UploadQueue, store: QueueStore, staging: StagingArea, launchedAt: Date
    ) async -> Report {
        let loaded: QueueStore.Loaded
        do {
            loaded = try await queue.load()
        } catch {
            return Report(loaded: nil, swept: nil)
        }
        guard let owners = try? store.recordIDs() else { return Report(loaded: loaded, swept: nil) }
        let swept = try? staging.sweepItemFolders(keeping: owners, createdBefore: launchedAt)
        return Report(loaded: loaded, swept: swept)
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
            report = await attempt()
        }
        return report
    }
}
