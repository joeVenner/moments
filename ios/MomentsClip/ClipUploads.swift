import CredentialStore
import FeatureGuest
import Foundation
import MomentsAPI
import OSLog
import UploadEngine

/// The Clip's upload queue: the app's, minus what a Clip can't have. Parts
/// go while the Clip is open (an App Clip can't use a background session),
/// over any network (it has no settings, and holding a video for Wi-Fi
/// would hold it until the Clip closes). The queue lives in the Clip's own
/// container, which iOS deletes when the full app replaces the Clip, so
/// what hasn't finished by then is lost; the app doesn't continue it.
enum ClipUploads {
    struct Parts {
        let staging: StagingArea
        let submitter: QueueSubmitter
        let progress: UploadQueue
    }

    /// Nil (sharing hidden) if the folders can't be set up.
    static func start(client: MomentsClient, credentials: any EventCredentialStore) -> Parts? {
        let log = Logger(subsystem: "moments", category: "clip-uploads")
        let hosts = StorageHostPolicy.moments
        let staging: StagingArea
        let store: QueueStore
        do {
            staging = try StagingArea.appDefault()
            store = try QueueStore.appDefault()
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
            let report = await UploadLaunch.retrying {
                await UploadLaunch.prepare(queue: queue, store: store, staging: staging, launchedAt: launchedAt)
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
