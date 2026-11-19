import Foundation
import MomentsAPI
import MomentsDomain

/// Sends parts of a staged file to storage: `BackgroundPartUploader` in the
/// app, `URLSessionPartUploader` where background sessions aren't allowed.
public protocol PartUploader: Sendable {
    /// Called once by `UploadQueue.load()`, before anything uploads: picks
    /// up work an earlier launch left running and deletes part files
    /// nothing is sending (they hold photo bytes).
    func recover() async throws

    /// Sends these parts, read from `file` (opened and checked by the
    /// queue; never reopen the path), and returns the ones storage accepted.
    /// Throws a `MomentsAPIError` for failures the queue should react to.
    /// The credentials are secrets: never put them in a task description or
    /// a log.
    func upload(
        parts: [Int], session: QueuedUpload.SessionRef, item: QueuedUpload, file: FileHandle,
        credentials: EventCredentials
    ) async throws -> Set<Int>
}

/// What the credentials lookup found for an event.
public enum CredentialsLookupResult: Sendable {
    case found(EventCredentials)
    /// The guest has no credentials for the event (must join again).
    case missing
    /// Can't tell right now (keychain locked before first unlock).
    case unavailable
}

/// Runs the upload queue: owns the saved records and the staged files,
/// performs each item's next action and feeds the answer back into it.
/// Every decision lives in `QueuedUpload`; this only does I/O, saves after
/// each change and tells the UI.
public actor UploadQueue {
    public enum EnqueueError: Error, Equatable, Sendable {
        /// The queue holds `maxItems` (counting records it couldn't load).
        case full
        case duplicate
        /// `load()` runs once, at launch, before anything else.
        case alreadyLoaded
        /// `enqueue` before `load()` would leave the saved queue unread.
        case notLoaded
        /// The staged file can't be used.
        case file(StagingArea.Problem)
        /// The guest is leaving the item's event.
        case leaving
    }

    public typealias CredentialsLookup = @Sendable (_ eventSlug: String) async -> CredentialsLookupResult

    /// How long to hold an item whose staged file or credentials can't be
    /// read yet (the phone is locked).
    public static let unreadableHold: TimeInterval = 30
    /// How long to hold an item whose request changed nothing (an answer it
    /// ignored), so a misbehaving server can't make it spin.
    public static let noProgressHold: TimeInterval = 5

    private let store: QueueStore
    private let staging: StagingArea
    private let service: any UploadService
    private let partUploader: any PartUploader
    private let lookUpCredentials: CredentialsLookup
    private let now: @Sendable () -> Date
    private let jitter: @Sendable (TimeInterval) -> TimeInterval

    private var items: [UUID: QueuedUpload] = [:]
    private var order: [UUID] = []
    /// Records on disk that weren't loaded (deferred or overflow). They
    /// count toward the cap, and their staged files are never touched.
    private var unloaded = 0
    private var inFlight: Set<UUID> = []
    /// Events the guest is leaving (with how many leaves overlap): none of
    /// their items starts and nothing is enqueued for them meanwhile.
    private var leavingEvents: [String: Int] = [:]
    private var heldUntil: [UUID: Date] = [:]
    private var observers: [UUID: AsyncStream<[QueuedUpload]>.Continuation] = [:]
    private var sleeper: Task<Void, Never>?
    private var isRunning = false
    private var isLoaded = false
    private var isLoading = false

    /// Saves that failed; the item stays current in memory and the next
    /// change saves it again.
    public private(set) var saveFailures = 0
    /// Staged files of finished items that couldn't be deleted.
    public private(set) var cleanupFailures = 0

    public init(
        store: QueueStore, staging: StagingArea, service: any UploadService, partUploader: any PartUploader,
        credentials: @escaping CredentialsLookup,
        now: @escaping @Sendable () -> Date = { Date() },
        jitter: @escaping @Sendable (TimeInterval) -> TimeInterval = UploadQueue.defaultJitter
    ) {
        self.store = store
        self.staging = staging
        self.service = service
        self.partUploader = partUploader
        lookUpCredentials = credentials
        self.now = now
        self.jitter = jitter
    }

    /// Up to 10% of the wait, at most 30 s, so many phones that failed
    /// together don't retry together.
    public static let defaultJitter: @Sendable (TimeInterval) -> TimeInterval = { wait in
        Double.random(in: 0 ... max(min(wait * 0.1, 30), 0))
    }

    // MARK: Queue

    /// Loads the saved queue at launch. Items that had a session re-read it
    /// before sending anything (storage may be ahead of the record).
    /// Call once, before enqueueing or running.
    @discardableResult
    public func load() async throws -> QueueStore.Loaded {
        guard !isLoaded, !isLoading else { throw EnqueueError.alreadyLoaded }
        // Before the records are read: until `isLoaded`, nothing can be
        // enqueued and there is nothing to run.
        isLoading = true
        defer { isLoading = false }
        do {
            try await partUploader.recover()
        } catch {
            cleanupFailures += 1
        }
        let loaded = try store.load()
        isLoaded = true
        unloaded = loaded.deferred + loaded.overflow
        for var item in loaded.items {
            let before = item
            item.reconcileOnLaunch()
            if item != before { persist(item) }
            items[item.id] = item
            order.append(item.id)
        }
        publish()
        return loaded
    }

    /// Adds a prepared upload. Its staged file must exist as recorded, in
    /// the item's own staging folder.
    public func enqueue(_ item: QueuedUpload) throws {
        guard isLoaded else { throw EnqueueError.notLoaded }
        guard items[item.id] == nil else { throw EnqueueError.duplicate }
        guard leavingEvents[item.eventSlug] == nil else { throw EnqueueError.leaving }
        guard items.count + unloaded < store.maxItems else { throw EnqueueError.full }
        do throws(StagingArea.Problem) {
            _ = try staging.open(item.file, owner: item.id)
        } catch {
            throw EnqueueError.file(error)
        }
        try store.save(item)
        items[item.id] = item
        order.append(item.id)
        publish()
        wake()
    }

    /// The items in queue order.
    public func snapshot() -> [QueuedUpload] {
        order.compactMap { items[$0] }
    }

    /// The queue now and after every change, for the UI.
    public func updates() -> AsyncStream<[QueuedUpload]> {
        let (stream, continuation) = AsyncStream.makeStream(of: [QueuedUpload].self, bufferingPolicy: .bufferingNewest(1))
        let id = UUID()
        observers[id] = continuation
        continuation.yield(snapshot())
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeObserver(id) }
        }
        return stream
    }

    /// The guest tapped "Try again".
    public func retry(id: UUID) {
        guard var item = items[id] else { return }
        let before = item
        item.retryByGuest()
        guard item != before else { return }
        heldUntil[id] = nil
        store(item)
        wake()
    }

    /// Removes a finished item (done or failed) and its staged file.
    public func discard(id: UUID) throws {
        guard let item = items[id], item.isFinished, !inFlight.contains(id) else { return }
        try store.remove(id: id)
        items[id] = nil
        order.removeAll { $0 == id }
        heldUntil[id] = nil
        removeStagedFile(of: item)
        publish()
    }

    /// The guest is leaving `eventSlug`, which deletes their uploads: until
    /// `endLeaving`, nothing of that event starts or can be enqueued. Waits
    /// (up to `timeout`, or until cancelled) for a request already running
    /// for one of its items, so a "complete" doesn't race the server's
    /// leave; then removes every item of the event, records not loaded at
    /// launch included, with their staged files. An item still sending
    /// after the wait is removed too (its late answer is ignored). Returns
    /// how many were removed. Calls may overlap; each needs `endLeaving`.
    @discardableResult
    public func beginLeaving(eventSlug: String, waitingAtMost timeout: Duration = .seconds(10)) async -> Int {
        leavingEvents[eventSlug, default: 0] += 1
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline, snapshot().contains(where: { $0.eventSlug == eventSlug && inFlight.contains($0.id) }) {
            do {
                try await Task.sleep(for: .milliseconds(50))
            } catch {
                break // Cancelled: remove now rather than spin.
            }
        }
        let handled = Set(items.keys)
        var removed = 0
        for item in snapshot() where item.eventSlug == eventSlug {
            remove(item)
            removed += 1
        }
        do {
            // Loaded items are handled above, even one whose record stayed.
            let others = try store.removeRecords(eventSlug: eventSlug, excluding: handled)
            unloaded = max(unloaded - others.count, 0)
            for item in others { removeStagedFile(of: item) }
            removed += others.count
        } catch {
            // Left on disk; without the guest's token they can't upload.
            cleanupFailures += 1
        }
        publish()
        return removed
    }

    /// The leave that `beginLeaving` started is over (left or failed).
    public func endLeaving(eventSlug: String) {
        guard let count = leavingEvents[eventSlug] else { return }
        leavingEvents[eventSlug] = count > 1 ? count - 1 : nil
    }

    /// Removes every item that finished successfully.
    public func clearDone() throws {
        for item in snapshot() {
            if case .done = item.phase { try discard(id: item.id) }
        }
    }

    // MARK: Running

    /// Runs until cancelled: performs whatever is due, then sleeps until the
    /// next item is due (with jitter) or something is enqueued or retried.
    /// Only one `run()` at a time; a second call returns at once.
    public func run() async {
        guard !isRunning else { return }
        isRunning = true
        defer { isRunning = false }
        while !Task.isCancelled {
            let (didWork, next) = await runDue()
            let current = now()
            var delay = next.map { $0.timeIntervalSince(current) } ?? 3600
            if let next, next > current { delay += jitter(next.timeIntervalSince(current)) }
            // Nothing changed but something claims to be due: don't spin.
            if !didWork { delay = max(delay, 1) }
            guard !Task.isCancelled else { break }
            guard delay > 0 else { continue }
            let task = Task<Void, Never> { _ = try? await Task.sleep(for: .seconds(delay)) }
            sleeper = task
            await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
            sleeper = nil
        }
    }

    /// For a background wake: performs due work until nothing is in flight
    /// and nothing is due now, or `seconds` pass, so finished parts reach
    /// "complete" before the app tells the system it is done. Safe beside
    /// `run()`: an item already in flight is never stepped twice.
    public func settle(within seconds: TimeInterval) async {
        let deadline = now().addingTimeInterval(seconds)
        while !Task.isCancelled, now() < deadline {
            let (didWork, next) = await runDue()
            let isIdle = inFlight.isEmpty && (next.map { $0 > now() } ?? true)
            if !didWork, isIdle { return }
            // Polls: a part in flight has no completion signal to await here.
            // A cancelled sleep is fine; the loop checks cancellation.
            try? await Task.sleep(for: .milliseconds(250))
        }
    }

    /// Performs the due action of every item once, in queue order. Returns
    /// whether any item changed and when the next item is due (nil: nothing
    /// left to do). Stops early when cancelled.
    @discardableResult
    public func runDue() async -> (didWork: Bool, next: Date?) {
        var didWork = false
        for id in order {
            if Task.isCancelled { break }
            if await step(id: id) { didWork = true }
        }
        return (didWork, nextDue())
    }

    /// Performs one item's due action, if any. True when the item changed.
    /// A request whose answer changed nothing holds the item briefly, so it
    /// is never asked again in a tight loop.
    @discardableResult
    public func step(id: UUID) async -> Bool {
        guard let item = items[id], !inFlight.contains(id), leavingEvents[item.eventSlug] == nil else { return false }
        let current = now()
        if let held = heldUntil[id], held > current { return false }
        let action = item.nextAction(now: current)
        switch action {
        case .none, .wait: return false
        case .startSession, .readSession, .complete, .uploadParts: break
        }
        inFlight.insert(id)
        defer { inFlight.remove(id) }
        guard let event = await perform(action, for: item) else { return false }
        if apply(event, to: id) { return true }
        // A removed item (the guest left meanwhile) needs no hold.
        if items[id] != nil, !Task.isCancelled { heldUntil[id] = now().addingTimeInterval(Self.noProgressHold) }
        return false
    }

    // MARK: Internals

    /// The answer to one action as an event for the item, tagged with the
    /// ids of the request made (so a late answer can't touch a newer
    /// session). Nil when there is nothing to record.
    private func perform(_ action: QueuedUpload.Action, for item: QueuedUpload) async -> QueuedUpload.Event? {
        let clientID = item.clientUploadID
        let credentials: EventCredentials
        switch await lookUpCredentials(item.eventSlug) {
        case let .found(found): credentials = found
        case .missing: return .requestFailed(.guestRequired, clientUploadID: clientID)
        case .unavailable:
            heldUntil[item.id] = now().addingTimeInterval(Self.unreadableHold)
            return nil
        }
        var file: FileHandle?
        if case .uploadParts = action {
            do throws(StagingArea.Problem) {
                file = try staging.open(item.file, owner: item.id)
            } catch .unreadable {
                heldUntil[item.id] = now().addingTimeInterval(Self.unreadableHold)
                return nil
            } catch {
                return .fileLost(clientUploadID: clientID)
            }
        }
        do {
            switch action {
            case let .startSession(upload):
                return .sessionStarted(try await service.startUpload(upload, slug: item.eventSlug, credentials: credentials))
            case let .readSession(session):
                return .progressRead(try await service.uploadProgress(slug: item.eventSlug, uploadID: session.id, credentials: credentials))
            case let .complete(session):
                return .completeAnswered(try await service.completeUpload(slug: item.eventSlug, uploadID: session.id, credentials: credentials))
            case let .uploadParts(session, parts):
                guard let file else { return nil }
                let sent = try await partUploader.upload(
                    parts: parts, session: session, item: item, file: file, credentials: credentials
                )
                // Nothing accepted counts as a failure, or the same parts
                // would be asked for again at once.
                guard !sent.isDisjoint(with: parts) else { return .requestFailed(.transport(nil), clientUploadID: clientID) }
                return .partsUploaded(sent, sessionID: session.id)
            case .wait, .none:
                return nil
            }
        } catch {
            // Shutting down is nobody's fault: don't count a try.
            if Task.isCancelled || error is CancellationError { return nil }
            if let error = error as? MomentsAPIError { return .requestFailed(error, clientUploadID: clientID) }
            return .requestFailed(.transport(nil), clientUploadID: clientID)
        }
    }

    /// True when the item changed.
    private func apply(_ event: QueuedUpload.Event, to id: UUID) -> Bool {
        guard var item = items[id] else { return false }
        let before = item
        item.apply(event, now: now())
        guard item != before else { return false }
        // The staged file goes only once "done" is saved; otherwise a
        // relaunch would find an unfinished record without its file.
        // `discard` / `clearDone` retry the cleanup.
        if store(item), case .done = item.phase { removeStagedFile(of: item) }
        return true
    }

    /// Keeps the item, saves it and tells the UI. False when the save
    /// failed (the item stays current in memory; the next change saves it).
    @discardableResult
    private func store(_ item: QueuedUpload) -> Bool {
        items[item.id] = item
        let saved = persist(item)
        publish()
        return saved
    }

    @discardableResult
    private func persist(_ item: QueuedUpload) -> Bool {
        do {
            try store.save(item)
            return true
        } catch {
            saveFailures += 1
            return false
        }
    }

    /// Drops one item: record, memory and staged file.
    private func remove(_ item: QueuedUpload) {
        do {
            try store.remove(id: item.id)
        } catch {
            // Kept on disk; without the guest's token it can't upload.
            saveFailures += 1
        }
        items[item.id] = nil
        order.removeAll { $0 == item.id }
        heldUntil[item.id] = nil
        removeStagedFile(of: item)
    }

    private func removeStagedFile(of item: QueuedUpload) {
        do throws(StagingArea.Problem) {
            try staging.remove(item.file, owner: item.id)
        } catch {
            cleanupFailures += 1
        }
    }

    private func nextDue() -> Date? {
        let current = now()
        var next: Date?
        for item in snapshot() where !inFlight.contains(item.id) {
            var due: Date
            switch item.nextAction(now: current) {
            case .none: continue
            case let .wait(until): due = until
            default: due = current
            }
            if let held = heldUntil[item.id], held > due { due = held }
            next = min(next ?? due, due)
        }
        return next
    }

    private func publish() {
        let items = snapshot()
        for observer in observers.values { observer.yield(items) }
    }

    private func removeObserver(_ id: UUID) {
        observers[id] = nil
    }

    private func wake() {
        sleeper?.cancel()
    }

    deinit {
        for observer in observers.values { observer.finish() }
    }
}
