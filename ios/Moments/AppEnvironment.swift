import CredentialStore
import FeatureGuest
import FeatureHost
import Foundation
import MomentsAPI
import OSLog
import UploadEngine

/// App-wide dependencies, built once at launch.
@MainActor
struct AppEnvironment {
    let service: any MomentsService
    let credentials: any EventCredentialStore
    let guest: GuestDependencies
    /// The host screens' API and where the host's session token is kept.
    let hostService: any HostService
    /// Built once here: the account reads the keychain when created.
    let hostAccount: HostAccount
    let hostEvents: HostEventsModel
    /// "Download everything": files from the API origin into Photos.
    let hostDownloads: HostDownloads

    static let productionBaseURL = URL(string: "https://moments-hq.com")!

    /// Debug builds can point at `npm run dev` with the scheme's
    /// `MOMENTS_API_BASE_URL` (localhost only; credentials go there).
    static var baseURL: URL {
        #if DEBUG
        if let override = ProcessInfo.processInfo.environment["MOMENTS_API_BASE_URL"],
           let url = URL(string: override), ["localhost", "127.0.0.1"].contains(url.host()) {
            return url
        }
        #endif
        return productionBaseURL
    }

    /// The app's environment, built once per process: the background upload
    /// session behind it can't be created twice.
    static func live() -> AppEnvironment { shared }

    private static let shared: AppEnvironment = build()

    private static func build() -> AppEnvironment {
        let credentials = KeychainEventCredentialStore()
        do {
            try CredentialLifecycle.resetIfFreshInstall(credentials)
        } catch {
            // Status only; never the item contents.
            Logger(subsystem: "moments", category: "credentials").error("fresh-install reset failed: \(String(describing: error), privacy: .public)")
        }
        // Before any screen can open the photo picker: picked originals
        // (with their location data) left by an earlier run go.
        GuestUploadsLaunch.clearLeftovers()
        let client = makeClient()
        // The app-hosted test run launches the app too: no real queue there.
        let isHostingTests = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        let uploads = isHostingTests ? nil : startUploads(client: client, credentials: credentials)
        // No queue to hand session events to: release the system at once.
        if uploads == nil { BackgroundUploadEvents.connect { systemCompletion in systemCompletion() } }
        return make(client: client, credentials: credentials, hostSessions: KeychainHostSessionStore(), uploads: uploads)
    }

    /// For tests and previews: no keychain, no network calls until used.
    static func inMemory() -> AppEnvironment {
        // No uploads: a background session can't be created twice per process.
        make(client: makeClient(), credentials: InMemoryEventCredentialStore(), hostSessions: InMemoryHostSessionStore(), uploads: nil)
    }

    private static func make(
        client: MomentsClient, credentials: any EventCredentialStore, hostSessions: any HostSessionStore,
        uploads: UploadDependencies?
    ) -> AppEnvironment {
        // Hearts belong to the joined guest (the X-Guest-Token), so the
        // device needs no reactor id of its own.
        let guest = GuestDependencies(
            service: client, store: credentials, mediaFetcher: makeMediaFetcher(), uploads: uploads, leaver: client
        )
        let hostAccount = HostAccount(service: client, store: hostSessions)
        return AppEnvironment(
            service: client, credentials: credentials, guest: guest, hostService: client,
            hostAccount: hostAccount, hostEvents: HostEventsModel(service: client, account: hostAccount),
            hostDownloads: makeHostDownloads()
        )
    }

    // MARK: Uploads

    /// The background URLSession's identifier; one per app, never reused.
    static let uploadSessionIdentifier = "com.moments-hq.moments.uploads"
    /// Our R2 account: the only storage host part URLs may name.
    static let storageAccountID = "30062218f6ae591808563f1afd8c479a"

    /// Builds the upload queue on the app's one background session, then
    /// loads it, sweeps prepared files nothing owns, and runs it for the
    /// app's life. Nil (uploads hidden) if the folders can't be set up.
    private static func startUploads(client: MomentsClient, credentials: any EventCredentialStore) -> UploadDependencies? {
        let log = Logger(subsystem: "moments", category: "uploads")
        guard let hosts = StorageHostPolicy.r2Account(storageAccountID) else {
            fatalError("the storage account id must be a valid R2 account id")
        }
        let staging: StagingArea
        let store: QueueStore
        do {
            staging = try StagingArea.appDefault()
            store = try QueueStore.appDefault()
        } catch {
            // Counts and types only: paths can hold the user's name on a Mac.
            log.error("upload folders unavailable: \(String(describing: type(of: error)), privacy: .public)")
            return nil
        }
        let uploader = BackgroundPartUploader(identifier: uploadSessionIdentifier, service: client, staging: staging, hosts: hosts)
        let queue = UploadQueue(
            store: store, staging: staging, service: client, partUploader: uploader,
            credentials: uploadCredentialsLookup(store: credentials),
            thumbnailSender: URLSessionThumbnailSender(hosts: hosts)
        )
        let launchedAt = Date()
        // Sharing waits for this, so it runs at the guest's priority.
        let launch = Task(priority: .userInitiated) { () -> Bool in
            // A failed read leaves the queue unloaded, so it can be tried again
            // (a passing I/O error); after that, sharing reports a failure.
            var report = await UploadLaunch.prepare(queue: queue, store: store, staging: staging, launchedAt: launchedAt)
            for delay in [1, 3] where report.loaded == nil {
                try? await Task.sleep(for: .seconds(delay))
                report = await UploadLaunch.prepare(queue: queue, store: store, staging: staging, launchedAt: launchedAt)
            }
            guard let loaded = report.loaded else {
                log.error("upload queue could not load")
                return false
            }
            log.info("upload queue loaded: \(loaded.items.count, privacy: .public) items, \(loaded.deferred, privacy: .public) deferred, \(loaded.quarantined, privacy: .public) set aside, sweep \(report.swept.map(String.init) ?? "skipped", privacy: .public)")
            return true
        }
        Task {
            // Runs for the app's life, once loaded; a dead queue isn't run.
            guard await launch.value else { return }
            await queue.run()
        }
        // A background wake: let finished parts reach "complete" before
        // telling the system the session's events are handled.
        BackgroundUploadEvents.connect { systemCompletion in
            uploader.handleBackgroundEvents {
                Task {
                    if await launch.value { await queue.settle(within: 20) }
                    systemCompletion()
                }
            }
        }
        return UploadDependencies(
            staging: staging, submitter: QueueSubmitter(queue: queue, isReady: { await launch.value }), progress: queue,
            // A queue that didn't load holds nothing to remove; its records
            // can't upload once the guest's token is gone.
            leaving: LeavingUploads(
                begin: { slug in if await launch.value { await queue.beginLeaving(eventSlug: slug) } },
                end: { slug in await queue.endLeaving(eventSlug: slug) }
            )
        )
    }

    private static func makeMediaFetcher() -> MediaFetcher {
        if let fetcher = try? MediaFetcher(baseURL: baseURL, identity: .fromBundle()) { return fetcher }
        guard let fetcher = try? MediaFetcher(baseURL: productionBaseURL, identity: .fromBundle()) else {
            fatalError("the production base URL must be accepted")
        }
        return fetcher
    }

    /// The same base URL as the client, so the files the model accepts are
    /// the ones the downloader may fetch.
    private static func makeHostDownloads() -> HostDownloads {
        for origin in [baseURL, productionBaseURL] {
            if let downloader = try? MediaFileDownloader(baseURL: origin, identity: .fromBundle()) {
                return HostDownloads(origin: origin, downloader: downloader, saver: PhotoLibrarySaver())
            }
        }
        fatalError("the production base URL must be accepted")
    }

    private static func makeClient() -> MomentsClient {
        if let client = try? MomentsClient(baseURL: baseURL, identity: .fromBundle()) { return client }
        // Only a malformed debug override gets here.
        guard let client = try? MomentsClient(baseURL: productionBaseURL, identity: .fromBundle()) else {
            fatalError("the production base URL must be accepted")
        }
        return client
    }
}
