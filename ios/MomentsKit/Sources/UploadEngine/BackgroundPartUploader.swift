import Foundation
import MomentsAPI
import MomentsDomain

/// Sends parts to storage on a background URLSession, so uploads go on
/// while the app is suspended or after the system ends it. The full app
/// creates exactly one, at launch, and keeps it (a background session
/// identifier can't be used twice in one process).
///
/// Each part is copied from the checked staged-file handle into
/// `<staging>/.parts/<ITEM>-<part>` and handed to the system with
/// `uploadTask(with:fromFile:)`; the file is deleted when its task ends.
/// Tasks are labelled `<ITEM>:<part>` only. After a relaunch, `recover()`
/// adopts the tasks still running, so a part the queue asks for again is
/// waited on rather than sent twice; whatever finished meanwhile is kept
/// for the next `upload` call. The server stays the source of truth: a
/// result lost with the process only costs a resend.
///
/// The same storage rules as the foreground uploader apply
/// (`StorageTarget`). Background sessions follow redirects without asking
/// the delegate, so a part whose final URL differs from the one signed is
/// treated as failed.
public final class BackgroundPartUploader: PartUploader, Sendable {
    /// Part files that may exist at once per upload call; each is up to a
    /// part size (8 MiB), so a large video doesn't stage a second copy.
    public static let defaultMaxPartFiles = 4

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

    /// The app's uploader, on the background session `identifier`.
    public convenience init(identifier: String, service: any UploadService, staging: StagingArea, hosts: StorageHostPolicy) {
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        self.init(service: service, staging: staging, hosts: hosts, configuration: configuration)
    }

    /// Any configuration (tests use an ephemeral one with a stub protocol).
    init(
        service: any UploadService, staging: StagingArea, hosts: StorageHostPolicy, configuration: URLSessionConfiguration,
        maxPartFiles: Int = BackgroundPartUploader.defaultMaxPartFiles
    ) {
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
        // The delegate holds the task book and the staging area, never the
        // uploader.
        session = URLSession(configuration: configuration, delegate: SessionEvents(tasks: tasks, staging: staging), delegateQueue: nil)
    }

    /// Call from the app delegate's `handleEventsForBackgroundURLSession`:
    /// `completion` runs on the main queue once the system has delivered
    /// every event for this session.
    public func handleBackgroundEvents(completion: @escaping @MainActor @Sendable () -> Void) {
        tasks.setBackgroundCompletion(completion)
    }

    /// Adopts the tasks still running from an earlier launch and deletes
    /// every part file none of them is sending. Tasks this app didn't label
    /// are cancelled.
    public func recover() async throws {
        var live: Set<String> = []
        for task in await session.allTasks {
            guard let key = PartTaskKey(label: task.taskDescription), task.state == .running || task.state == .suspended else {
                if task.state != .completed { task.cancel() }
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
        var sent: Set<Int> = []
        var jobs: [Job] = []
        var toSend: [Int] = []
        for part in parts {
            switch tasks.take(PartTaskKey(item: item.id, part: part)) {
            case .finished(.success): sent.insert(part)
            case .running: jobs.append(.wait(part))
            case .finished(.failure), nil: toSend.append(part)
            }
        }
        if !toSend.isEmpty {
            do {
                let batch = try await service.partURLs(slug: item.eventSlug, uploadID: ref.id, parts: toSend, credentials: credentials)
                jobs += try StorageTarget.checked(batch, parts: toSend, hosts: hosts, pins: pins, sessionID: ref.id)
                    .map { Job.send($0.part, $0.url) }
            } catch {
                // Parts still running keep going; their results wait for
                // the next call.
                if sent.isEmpty || !StorageTarget.isRetryable(error) { throw error }
                return sent
            }
        }
        var failures: [any Error] = []
        await withTaskGroup(of: (part: Int, error: (any Error)?).self) { group in
            var pending = jobs.makeIterator()
            for _ in 0 ..< maxPartFiles {
                guard let job = pending.next() else { break }
                group.addTask { await self.run(job, ref: ref, item: item, file: file) }
            }
            while let result = await group.next() {
                if let error = result.error {
                    failures.append(error)
                } else {
                    sent.insert(result.part)
                }
                // After a failure, the parts in flight finish but no more
                // start.
                if failures.isEmpty, let job = pending.next() {
                    group.addTask { await self.run(job, ref: ref, item: item, file: file) }
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

    private enum Job: Sendable {
        /// A task from earlier is already sending it.
        case wait(Int)
        case send(Int, URL)
    }

    private func run(_ job: Job, ref: QueuedUpload.SessionRef, item: QueuedUpload, file: FileHandle) async -> (part: Int, error: (any Error)?) {
        let part: Int
        switch job {
        case let .wait(number): part = number
        case let .send(number, url):
            part = number
            do {
                try Task.checkCancellation()
                try start(part: number, of: ref, item: item, file: file, to: url)
            } catch {
                return (part, error)
            }
        }
        do {
            // Cancelling stops the wait, not the upload: the task finishes
            // in the background and its result waits for the next call.
            try await tasks.wait(for: PartTaskKey(item: item.id, part: part))
            return (part, nil)
        } catch {
            return (part, error)
        }
    }

    /// Writes the part file and starts its task.
    private func start(part number: Int, of ref: QueuedUpload.SessionRef, item: QueuedUpload, file: FileHandle, to url: URL) throws {
        let key = PartTaskKey(item: item.id, part: number)
        guard let range = UploadPlan.byteRange(part: number, size: item.file.size, partSize: ref.partSize) else {
            throw MomentsAPIError.invalidUpload
        }
        let partURL: URL
        do throws(StagingArea.Problem) {
            partURL = try staging.partsFolder().appending(path: key.fileName, directoryHint: .notDirectory)
        } catch {
            throw MomentsAPIError.transport(nil)
        }
        try writePart(from: file, range: range, to: partURL)
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let task = session.uploadTask(with: request, fromFile: partURL)
        task.taskDescription = key.label
        // Marked running before it can finish, so its result is never
        // taken for an unknown task's.
        tasks.start(key)
        task.resume()
    }

    private func writePart(from file: FileHandle, range: Range<Int64>, to url: URL) throws(MomentsAPIError) {
        writeLock.lock()
        defer { writeLock.unlock() }
        // A copy left by an earlier attempt; no task is sending it (the
        // task book said so), and the file is created exclusively.
        unlink(url.path(percentEncoded: false))
        do throws(PartFile.Problem) {
            try PartFile.write(from: file, range: range, to: url)
        } catch .shortRead {
            throw .invalidUpload
        } catch {
            throw .transport(nil)
        }
    }

    /// A finished task's result as the queue understands it.
    static func outcome(original: URL?, final: URL?, response: URLResponse?, error: (any Error)?) -> Result<Void, MomentsAPIError> {
        if let error {
            return .failure(.transport((error as? URLError)?.code))
        }
        // Followed a redirect: the bytes may have gone somewhere unsigned.
        guard let original, let final, original.host()?.lowercased() == final.host()?.lowercased(),
              original.path(percentEncoded: true) == final.path(percentEncoded: true)
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

/// The session's delegate: deletes each part file when its task ends and
/// hands the result to the task book.
final class SessionEvents: NSObject, URLSessionTaskDelegate, Sendable {
    private let tasks: PartTasks
    private let staging: StagingArea

    init(tasks: PartTasks, staging: StagingArea) {
        self.tasks = tasks
        self.staging = staging
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        guard let key = PartTaskKey(label: task.taskDescription) else { return }
        // Deleted before the result is recorded, so a resend never finds
        // this task's file in its way.
        unlink(staging.partFileURL(named: key.fileName).path(percentEncoded: false))
        tasks.finish(key, BackgroundPartUploader.outcome(
            original: task.originalRequest?.url, final: task.currentRequest?.url, response: task.response, error: error
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

/// What is known about each part's task: running (with whoever waits for
/// it) or finished with a result no one has collected yet.
final class PartTasks: @unchecked Sendable {
    enum State {
        case running
        case finished(Result<Void, MomentsAPIError>)
    }

    /// Uncollected results beyond this are dropped (a resend recovers them).
    static let maxFinished = 1024

    private enum Entry {
        case running([UUID: CheckedContinuation<Void, any Error>])
        case finished(Result<Void, MomentsAPIError>)
    }

    private let lock = NSLock()
    private var entries: [PartTaskKey: Entry] = [:]
    private var finishedCount = 0
    private var backgroundCompletion: (@MainActor @Sendable () -> Void)?

    /// The part's state; a finished result is handed over once.
    func take(_ key: PartTaskKey) -> State? {
        lock.withLock {
            switch entries[key] {
            case .running: return .running
            case let .finished(result):
                entries[key] = nil
                finishedCount -= 1
                return .finished(result)
            case nil: return nil
            }
        }
    }

    /// A task for the part was just created.
    func start(_ key: PartTaskKey) {
        lock.withLock {
            if case .finished = entries[key] { finishedCount -= 1 }
            entries[key] = .running([:])
        }
    }

    /// A task from an earlier launch is still sending the part (unless its
    /// result already arrived).
    func adopt(_ key: PartTaskKey) {
        lock.withLock {
            if entries[key] == nil { entries[key] = .running([:]) }
        }
    }

    /// Waits for the part's running task. A result that already arrived
    /// is returned at once; cancelling stops only the wait.
    func wait(for key: PartTaskKey) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                lock.withLock {
                    switch entries[key] {
                    case let .finished(result):
                        entries[key] = nil
                        finishedCount -= 1
                        continuation.resume(with: result.mapError { $0 as any Error })
                    case var .running(waiters):
                        if Task.isCancelled {
                            continuation.resume(throwing: CancellationError())
                        } else {
                            waiters[id] = continuation
                            entries[key] = .running(waiters)
                        }
                    case nil:
                        continuation.resume(throwing: MomentsAPIError.transport(nil))
                    }
                }
            }
        } onCancel: {
            lock.withLock {
                guard case var .running(waiters) = entries[key], let waiter = waiters.removeValue(forKey: id) else { return }
                entries[key] = .running(waiters)
                waiter.resume(throwing: CancellationError())
            }
        }
    }

    /// The part's task ended: wakes its waiters, or keeps the result for
    /// the next upload call when no one waits.
    func finish(_ key: PartTaskKey, _ result: Result<Void, MomentsAPIError>) {
        lock.withLock {
            if case let .running(waiters) = entries[key], !waiters.isEmpty {
                entries[key] = nil
                for waiter in waiters.values { waiter.resume(with: result.mapError { $0 as any Error }) }
                return
            }
            if case .finished = entries[key] { finishedCount -= 1 }
            if finishedCount >= Self.maxFinished {
                entries = entries.filter { if case .finished = $0.value { false } else { true } }
                finishedCount = 0
            }
            entries[key] = .finished(result)
            finishedCount += 1
        }
    }

    func setBackgroundCompletion(_ completion: @escaping @MainActor @Sendable () -> Void) {
        lock.withLock { backgroundCompletion = completion }
    }

    func takeBackgroundCompletion() -> (@MainActor @Sendable () -> Void)? {
        lock.withLock {
            defer { backgroundCompletion = nil }
            return backgroundCompletion
        }
    }
}
