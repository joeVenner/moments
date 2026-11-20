import CredentialStore
import FeatureGuest
import Foundation
import MomentsAPI
import OSLog
import UploadEngine

/// The Clip's upload queue: the app's, minus what a Clip can't have. Parts
/// go while the Clip is open (an App Clip can't use a background session),
/// over any network (it has no settings, and holding a video for Wi-Fi
/// would hold it until the Clip closes). The queue lives in the App Group
/// (`UploadFolders.clip`), which outlives the Clip when the full app
/// replaces it, for the app to adopt. Without the group (an unsigned build)
/// it lives in the Clip's own container and is lost on install.
enum ClipUploads {
    struct Parts {
        let staging: StagingArea
        let submitter: QueueSubmitter
        let progress: UploadQueue
    }

    /// Nil (sharing hidden) if the folders can't be set up.
    static func start(
        client: MomentsClient, credentials: any EventCredentialStore, appGroup: String? = ClipCredentials.appGroup
    ) -> Parts? {
        let log = Logger(subsystem: "moments", category: "clip-uploads")
        let hosts = StorageHostPolicy.moments
        let staging: StagingArea
        let store: QueueStore
        do {
            let shared = try UploadFolders.clip(appGroup: appGroup)
            // A build without the group: uploads still go, but the app
            // can't pick up what's unfinished.
            if shared == nil { log.error("upload queue not in the App Group") }
            let folders = try shared ?? UploadFolders.under(
                FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            )
            staging = folders.staging
            store = folders.store
        } catch {
            // The type only: paths can hold the user's name on a Mac.
            log.error("upload folders unavailable: \(String(describing: type(of: error)), privacy: .public)")
            return nil
        }
        let queue = UploadQueue(
            store: store, staging: staging, service: client,
            partUploader: URLSessionPartUploader(service: client, staging: staging, hosts: hosts),
            credentials: uploadCredentialsLookup(store: credentials),
            thumbnailSender: URLSessionThumbnailSender(hosts: hosts)
        )
        let launchedAt = Date()
        let launch = Task(priority: .userInitiated) { () -> Bool in
            // As the app: a passing I/O error gets another try.
            // Finished and stale items go: the Clip has nowhere to clear them,
            // and they'd stay in the shared folder. Stale by the same rule
            // (`UploadLaunch.isStale`) and age as the app's takeover uses.
            let report = await UploadLaunch.retrying {
                await UploadLaunch.prepare(
                    queue: queue, store: store, staging: staging, launchedAt: launchedAt,
                    pruningAfter: CredentialHandoff.handoffWindow
                )
            }
            guard let loaded = report.loaded else {
                log.error("upload queue could not load")
                return false
            }
            log.info("upload queue loaded: \(loaded.items.count, privacy: .public) items")
            return true
        }
        Task {
            // Runs while the Clip does, once loaded.
            guard await launch.value else { return }
            await queue.run()
        }
        return Parts(staging: staging, submitter: QueueSubmitter(queue: queue, isReady: { await launch.value }), progress: queue)
    }
}
