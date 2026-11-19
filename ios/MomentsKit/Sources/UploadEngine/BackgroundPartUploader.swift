import Foundation
import MomentsAPI
import MomentsDomain

/// Sends parts to storage on a background URLSession, so uploads go on
/// while the app is suspended or after the system ends it. The full app
/// creates exactly one, at launch, and keeps it (a background session
/// identifier can't be used twice in one process).
///
/// Each attempt at a part copies its bytes from the checked staged-file
/// handle into its own file, `<staging>/.parts/<PartTaskKey.fileName>`,
/// hands it to the system with `uploadTask(with:fromFile:)`, and deletes it
/// when the task ends. Tasks are labelled with their `PartTaskKey` only.
/// After a relaunch, `recover()` adopts the tasks still running, so a part
/// the queue asks for again is waited on rather than sent twice; whatever
/// finished meanwhile is kept for the next `upload` call of the same
/// session. The server stays the source of truth: a result lost with the
/// process only costs a resend.
///
/// The same storage rules as the foreground uploader apply
/// (`StorageTarget`). Background sessions follow redirects without asking
/// the delegate, so a part whose final URL isn't exactly the signed one is
/// treated as failed — detection, not prevention: the bytes have gone by
/// then. The signed, account-pinned URL is what keeps them on our storage.
public final class BackgroundPartUploader: PartUploader, Sendable {
    /// Part files that may exist at once per upload call; each is up to a
    /// part size (8 MiB), so a large video doesn't stage a second copy.
    public static let defaultMaxPartFiles = 4
    /// How long the system keeps trying one part. Part URLs are signed for
    /// at least this long; past it the URL would be refused anyway.
    public static let resourceTimeout: TimeInterval = 24 * 60 * 60

    private let service: any UploadService
    private let staging: StagingArea
    private let hosts: StorageHostPolicy
    private let maxPartFiles: Int
    private let session: URLSession
    private let tasks: PartTasks
    private let pins = Pins()
    /// Part files are written from the one shared file handle; its offset
    /// is shared, so writes take turns.
    private let writeLock = NSLock()
    /// Read at each part, so a change applies to parts not yet started.
    private let largeVideosOnWiFiOnly: @Sendable () -> Bool

    /// The app's uploader, on the background session `identifier`.
    public convenience init(
        identifier: String, service: any UploadService, staging: StagingArea, hosts: StorageHostPolicy,
        largeVideosOnWiFiOnly: @escaping @Sendable () -> Bool = { CellularPolicy.largeVideosOnWiFiOnly() }
    ) {
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.timeoutIntervalForResource = Self.resourceTimeout
        self.init(
            service: service, staging: staging, hosts: hosts, configuration: configuration,
            largeVideosOnWiFiOnly: largeVideosOnWiFiOnly
        )
    }

    /// Any configuration (tests use an ephemeral one with a stub protocol).
    init(
        service: any UploadService, staging: StagingArea, hosts: StorageHostPolicy, configuration: URLSessionConfiguration,
        maxPartFiles: Int = BackgroundPartUploader.defaultMaxPartFiles,
        // Tests never hold parts for Wi-Fi unless they ask to.
        largeVideosOnWiFiOnly: @escaping @Sendable () -> Bool = { false }
    ) {
        self.largeVideosOnWiFiOnly = largeVideosOnWiFiOnly
        self.service = service
        self.staging = staging
        self.hosts = hosts
        self.maxPartFiles = max(maxPartFiles, 1)
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        let tasks = PartTasks()
        self.tasks = tasks
        // The delegate holds the task book, the staging area and the host
        // policy, never the uploader.
        session = URLSession(
            configuration: configuration, delegate: SessionEvents(tasks: tasks, staging: staging, hosts: hosts), delegateQueue: nil
        )
    }

    /// Call from the app delegate's `handleEventsForBackgroundURLSession`:
    /// `completion` runs on the main queue once the system has delivered
    /// every event for this session.
    public func handleBackgroundEvents(completion: @escaping @MainActor @Sendable () -> Void) {
        tasks.setBackgroundCompletion(completion)
    }

    /// Adopts the tasks still running from an earlier launch and deletes
    /// every part file none of them is sending. Tasks this app didn't label,
    /// or whose URL no longer passes the host policy, are cancelled.
    public func recover() async throws {
        var live: Set<String> = []
        for task in await session.allTasks {
            guard task.state == .running || task.state == .suspended else { continue }
            guard let key = PartTaskKey(label: task.taskDescription), let url = task.originalRequest?.url,
                  let host = StorageTarget.storageHost(of: url), hosts.allows(host)
            else {
                task.cancel()
                continue
            }
            tasks.adopt(key)
            live.insert(key.fileName)
            if task.state == .suspended { task.resume() }
        }
        try staging.clearPartFiles(keeping: live)
    }

    public func upload(
        parts: [Int], session ref: QueuedUpload.SessionRef, item: QueuedUpload, file: FileHandle,
        credentials: EventCredentials
    ) async throws -> Set<Int> {
        let parts = Array(Set(parts)).sorted()
        guard !parts.isEmpty else { return [] }
        let sessionTag = PartTaskKey.sessionTag(ref.id)
        var sent: Set<Int> = []
        var waits: [PartTaskKey] = []
        var toSend: [Int] = []
        for part in parts {
            switch tasks.take(PartSlot(item: item.id, part: part), session: sessionTag) {
            case .finished(.success): sent.insert(part)
            case let .running(key): waits.append(key)
            case .finished(.failure), nil: toSend.append(part)
            }
        }
        var sends: [(key: PartTaskKey, url: URL)] = []
        if !toSend.isEmpty {
            do {
                let batch = try await service.partURLs(slug: item.eventSlug, uploadID: ref.id, parts: toSend, credentials: credentials)
                sends = try StorageTarget.checked(batch, parts: toSend, hosts: hosts, pins: pins, sessionID: ref.id)
                    .map { (PartTaskKey(item: item.id, part: $0.part, session: sessionTag), $0.url) }
            } catch {
                // Parts still running keep going; their results wait for
                // the next call.
                if sent.isEmpty || error is CancellationError || !StorageTarget.isRetryable(error) { throw error }
                return sent
            }
        }
        var failures: [any Error] = []
        await withTaskGroup(of: Finished.self) { group in
            // Waiting creates no file, so only sends count against the window.
            for key in waits {
                group.addTask { await self.wait(for: key, isSend: false) }
            }
            var pending = sends.makeIterator()
            for _ in 0 ..< maxPartFiles {
                guard let next = pending.next() else { break }
                group.addTask { await self.send(next.key, to: next.url, ref: ref, item: item, file: file) }
            }
            while let finished = await group.next() {
                if let error = finished.error {
                    failures.append(error)
                } else {
                    sent.insert(finished.part)
                }
                // After a failure, the parts in flight finish but no more
                // start.
                if finished.isSend, failures.isEmpty, let next = pending.next() {
                    group.addTask { await self.send(next.key, to: next.url, ref: ref, item: item, file: file) }
                }
            }
        }
        // Same rule as the foreground uploader: progress is reported unless
        // the file itself was refused or nothing went through.
        if let refusal = failures.first(where: { !StorageTarget.isRetryable($0) }) { throw refusal }
        if let failure = failures.first, sent.isEmpty { throw failure }
        return sent
    }

    // MARK: Sending

    private struct Finished: Sendable {
        let part: Int
        let isSend: Bool
        let error: (any Error)?
    }

    private func send(_ key: PartTaskKey, to url: URL, ref: QueuedUpload.SessionRef, item: QueuedUpload, file: FileHandle) async -> Finished {
        do {
            try Task.checkCancellation()
            try start(key, to: url, ref: ref, item: item, file: file)
        } catch {
            return Finished(part: key.part, isSend: true, error: error)
        }
        return await wait(for: key, isSend: true)
    }

    /// Cancelling stops the wait, not the upload: the task finishes in the
    /// background and its result waits for the next call.
    private func wait(for key: PartTaskKey, isSend: Bool) async -> Finished {
        do {
            try await tasks.wait(for: key)
            return Finished(part: key.part, isSend: isSend, error: nil)
        } catch {
            return Finished(part: key.part, isSend: isSend, error: error)
        }
    }

    /// Writes the attempt's part file and starts its task.
    private func start(_ key: PartTaskKey, to url: URL, ref: QueuedUpload.SessionRef, item: QueuedUpload, file: FileHandle) throws {
        guard let range = UploadPlan.byteRange(part: key.part, size: item.file.size, partSize: ref.partSize) else {
            throw MomentsAPIError.invalidUpload
        }
        let partURL: URL
        do throws(StagingArea.Problem) {
            partURL = try staging.partsFolder().appending(path: key.fileName, directoryHint: .notDirectory)
        } catch {
            throw MomentsAPIError.transport(nil)
        }
        try writePart(from: file, range: range, to: partURL)
        let request = Self.partRequest(to: url, for: item, largeVideosOnWiFiOnly: largeVideosOnWiFiOnly())
        let task = session.uploadTask(with: request, fromFile: partURL)
        task.taskDescription = key.label
        // Recorded before it can finish, so its result always finds it.
        tasks.start(key)
        task.resume()
    }

    /// A part's PUT; held for Wi-Fi when the policy says so (a background
    /// task waits for one rather than failing).
    static func partRequest(to url: URL, for item: QueuedUpload, largeVideosOnWiFiOnly: Bool) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.allowsExpensiveNetworkAccess = CellularPolicy.allowsMobileData(
            contentType: item.file.contentType, size: item.file.size, largeVideosOnWiFiOnly: largeVideosOnWiFiOnly
        )
        return request
    }

    private func writePart(from file: FileHandle, range: Range<Int64>, to url: URL) throws(MomentsAPIError) {
        writeLock.lock()
        defer { writeLock.unlock() }
        do throws(PartFile.Problem) {
            try PartFile.write(from: file, range: range, to: url)
        } catch .shortRead {
            throw .invalidUpload
        } catch {
            throw .transport(nil)
        }
    }

    /// A finished task's result as the queue understands it.
    static func outcome(
        original: URL?, final: URL?, response: URLResponse?, error: (any Error)?, hosts: StorageHostPolicy
    ) -> Result<Void, MomentsAPIError> {
        if let error {
            return .failure(.transport((error as? URLError)?.code))
        }
        // Any redirect (another host, path, query, scheme or port) fails it.
        guard let original, let final, original == final, let host = StorageTarget.storageHost(of: final), hosts.allows(host)
        else { return .failure(.unexpectedResponse) }
        do throws(MomentsAPIError) {
            try StorageTarget.check(response)
            return .success(())
        } catch {
            return .failure(error)
        }
    }

    /// For tests: the session's delegate.
    var sessionDelegate: (any URLSessionDelegate)? { session.delegate }
}

/// The session's delegate: deletes each attempt's part file when its task
/// ends and hands the result to the task book.
final class SessionEvents: NSObject, URLSessionTaskDelegate, Sendable {
    private let tasks: PartTasks
    private let staging: StagingArea
    private let hosts: StorageHostPolicy

    init(tasks: PartTasks, staging: StagingArea, hosts: StorageHostPolicy) {
        self.tasks = tasks
        self.staging = staging
        self.hosts = hosts
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        guard let key = PartTaskKey(label: task.taskDescription) else { return }
        // The file is this attempt's alone.
        unlink(staging.partFileURL(named: key.fileName).path(percentEncoded: false))
        tasks.finish(key, BackgroundPartUploader.outcome(
            original: task.originalRequest?.url, final: task.currentRequest?.url, response: task.response, error: error,
            hosts: hosts
        ))
    }

    /// Not asked on background sessions; refuses on any other.
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        guard let completion = tasks.takeBackgroundCompletion() else { return }
        DispatchQueue.main.async { completion() }
    }
}

/// What is known about each part: the attempt running (with whoever waits
/// for it), or the latest attempt's result no one has collected yet.
/// Reports from any other attempt are ignored.
final class PartTasks: @unchecked Sendable {
    enum State {
        case running(PartTaskKey)
        case finished(Result<Void, MomentsAPIError>)
    }

    /// Uncollected results beyond this are all dropped (resends recover
    /// them).
    static let maxFinished = 1024

    private enum Entry {
        case running(PartTaskKey, [UUID: CheckedContinuation<Void, any Error>])
        case finished(PartTaskKey, Result<Void, MomentsAPIError>)
    }

    private let lock = NSLock()
    private var entries: [PartSlot: Entry] = [:]
    private var finishedCount = 0
    private var backgroundCompletion: (@MainActor @Sendable () -> Void)?
    /// The session finished delivering events before any handler arrived.
    /// It can outlive that wake; a later handler is then released at once,
    /// which is harmless because the app settles the queue before calling it.
    private var eventsFinishedEarly = false

    /// The part's state within this upload session. A finished result is
    /// handed over once; anything from another session counts as nothing
    /// (a result is dropped, a running attempt is left to end on its own).
    func take(_ slot: PartSlot, session: String) -> State? {
        lock.withLock {
            switch entries[slot] {
            case let .running(key, _):
                return key.session == session ? .running(key) : nil
            case let .finished(key, result):
                entries[slot] = nil
                finishedCount -= 1
                return key.session == session ? .finished(result) : nil
            case nil: return nil
            }
        }
    }

    /// A new attempt for the part was just created. Anyone still waiting on
    /// an attempt it replaces is told to try again.
    func start(_ key: PartTaskKey) {
        lock.withLock {
            switch entries[key.slot] {
            case let .running(_, waiters):
                for waiter in waiters.values { waiter.resume(throwing: MomentsAPIError.storageUnavailable) }
            case .finished: finishedCount -= 1
            case nil: break
            }
            entries[key.slot] = .running(key, [:])
        }
    }

    /// An attempt from an earlier launch is still sending the part (unless
    /// something newer is already known).
    func adopt(_ key: PartTaskKey) {
        lock.withLock {
            if entries[key.slot] == nil { entries[key.slot] = .running(key, [:]) }
        }
    }

    /// Waits for this attempt. A result that already arrived is returned
    /// at once; cancelling stops only the wait.
    func wait(for key: PartTaskKey) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                lock.withLock {
                    switch entries[key.slot] {
                    case let .finished(found, result) where found == key:
                        entries[key.slot] = nil
                        finishedCount -= 1
                        continuation.resume(with: result.mapError { $0 as any Error })
                    case .running(key, var waiters):
                        if Task.isCancelled {
                            continuation.resume(throwing: CancellationError())
                        } else {
                            waiters[id] = continuation
                            entries[key.slot] = .running(key, waiters)
                        }
                    default:
                        // Replaced by another attempt, or unknown.
                        continuation.resume(throwing: MomentsAPIError.storageUnavailable)
                    }
                }
            }
        } onCancel: {
            lock.withLock {
                guard case .running(key, var waiters) = entries[key.slot], let waiter = waiters.removeValue(forKey: id) else { return }
                entries[key.slot] = .running(key, waiters)
                waiter.resume(throwing: CancellationError())
            }
        }
    }

    /// An attempt's task ended: wakes its waiters, or keeps the result for
    /// the next upload call. Ignored if another attempt is running.
    func finish(_ key: PartTaskKey, _ result: Result<Void, MomentsAPIError>) {
        lock.withLock {
            switch entries[key.slot] {
            case let .running(running, waiters):
                guard running == key else { return }
                if !waiters.isEmpty {
                    entries[key.slot] = nil
                    for waiter in waiters.values { waiter.resume(with: result.mapError { $0 as any Error }) }
                    return
                }
            case let .finished(found, _):
                // Only a repeat of the same attempt replaces it; anything
                // else is older.
                guard found == key else { return }
                finishedCount -= 1
            case nil: break
            }
            if finishedCount >= Self.maxFinished {
                entries = entries.filter { if case .finished = $0.value { false } else { true } }
                finishedCount = 0
            }
            entries[key.slot] = .finished(key, result)
            finishedCount += 1
        }
    }

    /// Stores the system's handler for the session's events. Every handler
    /// runs exactly once: one already waiting is released first, and if the
    /// session finished its events before the handler arrived (a relaunch
    /// can deliver them early), the new one is released at once.
    func setBackgroundCompletion(_ completion: @escaping @MainActor @Sendable () -> Void) {
        let release: [@MainActor @Sendable () -> Void] = lock.withLock {
            var due: [@MainActor @Sendable () -> Void] = []
            if let earlier = backgroundCompletion { due.append(earlier) }
            if eventsFinishedEarly {
                eventsFinishedEarly = false
                backgroundCompletion = nil
                due.append(completion)
            } else {
                backgroundCompletion = completion
            }
            return due
        }
        for handler in release { DispatchQueue.main.async { handler() } }
    }

    /// The handler to release now the session delivered its events; nil
    /// when none arrived yet, which is remembered for `setBackgroundCompletion`.
    func takeBackgroundCompletion() -> (@MainActor @Sendable () -> Void)? {
        lock.withLock {
            guard let completion = backgroundCompletion else {
                eventsFinishedEarly = true
                return nil
            }
            backgroundCompletion = nil
            return completion
        }
    }
}
