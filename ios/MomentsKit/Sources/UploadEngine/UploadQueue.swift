import Foundation
import MomentsAPI
import MomentsDomain

/// Sends parts of a staged file to storage. The real one (background
/// URLSession) comes next; tests use a fake.
public protocol PartUploader: Sendable {
    /// Sends these parts and returns the ones storage accepted. Throws a
    /// `MomentsAPIError` for failures the queue should react to.
    func upload(
        parts: [Int], session: QueuedUpload.SessionRef, item: QueuedUpload, credentials: EventCredentials
    ) async throws -> Set<Int>
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
        /// The staged file can't be used.
        case file(StagingArea.Problem)
    }

    public typealias CredentialsLookup = @Sendable (_ eventSlug: String) async -> EventCredentials?

    /// How long to hold an item whose staged file can't be read yet (the
    /// phone is locked).
    public static let unreadableHold: TimeInterval = 30

    private let store: QueueStore
    private let staging: StagingArea
    private let service: any UploadService
    private let partUploader: any PartUploader
    private let credentials: CredentialsLookup
    private let now: @Sendable () -> Date
    private let jitter: @Sendable (TimeInterval) -> TimeInterval

    private var items: [UUID: QueuedUpload] = [:]
    private var order: [UUID] = []
    /// Records on disk that weren't loaded (deferred or overflow). They
    /// count toward the cap, and their staged files are never touched.
    private var unloaded = 0
    private var inFlight: Set<UUID> = []
    private var heldUntil: [UUID: Date] = [:]
    private var observers: [UUID: AsyncStream<[QueuedUpload]>.Continuation] = [:]
    private var sleeper: Task<Void, Never>?

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
        self.credentials = credentials
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
    @discardableResult
    public func load() throws -> QueueStore.Loaded {
        let loaded = try store.load()
        unloaded = loaded.deferred + loaded.overflow
        items = [:]
        order = []
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

    /// Adds a prepared upload. Its staged file must exist as recorded.
    public func enqueue(_ item: QueuedUpload) throws {
        guard items[item.id] == nil else { throw EnqueueError.duplicate }
        guard items.count + unloaded < store.maxItems else { throw EnqueueError.full }
        do {
            _ = try staging.open(item.file)
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

    /// Removes every item that finished successfully.
    public func clearDone() throws {
        for item in snapshot() {
            if case .done = item.phase { try discard(id: item.id) }
        }
    }

    // MARK: Running

    /// Runs until cancelled: performs whatever is due, then sleeps until the
    /// next item is due (with jitter) or something is enqueued or retried.
    public func run() async {
        while !Task.isCancelled {
            let (didWork, next) = await runDue()
            let current = now()
            var delay = next.map { $0.timeIntervalSince(current) } ?? 3600
            if let next, next > current { delay += jitter(next.timeIntervalSince(current)) }
            // Nothing moved but something claims to be due: don't spin.
            if !didWork { delay = max(delay, 1) }
            guard delay > 0 else { continue }
            let task = Task<Void, Never> { _ = try? await Task.sleep(for: .seconds(delay)) }
            sleeper = task
            await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
            sleeper = nil
        }
    }

    /// Performs the due action of every item once, in queue order. Returns
    /// whether anything ran and when the next item is due (nil: nothing
    /// left to do).
    @discardableResult
    public func runDue() async -> (didWork: Bool, next: Date?) {
        var didWork = false
        for id in order where await step(id: id) {
            didWork = true
        }
        return (didWork, nextDue())
    }

    /// Performs one item's due action, if any. True when it ran.
    @discardableResult
    public func step(id: UUID) async -> Bool {
        guard let item = items[id], !inFlight.contains(id) else { return false }
        let current = now()
        if let held = heldUntil[id], held > current { return false }
        let action = item.nextAction(now: current)
        switch action {
        case .none, .wait: return false
        case .startSession, .readSession, .complete, .uploadParts: break
        }
        inFlight.insert(id)
        defer { inFlight.remove(id) }
        let event = await perform(action, for: item)
        if let event { apply(event, to: id) }
        return true
    }

    // MARK: Internals

    /// The answer to one action as an event for the item, tagged with the
    /// ids of the request made (so a late answer can't touch a newer
    /// session). Nil when there is nothing to record.
    private func perform(_ action: QueuedUpload.Action, for item: QueuedUpload) async -> QueuedUpload.Event? {
        let clientID = item.clientUploadID
        guard let credentials = await credentials(item.eventSlug) else {
            return .requestFailed(.guestRequired, clientUploadID: clientID)
        }
        if case .uploadParts = action {
            do {
                _ = try staging.open(item.file)
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
                let sent = try await partUploader.upload(parts: parts, session: session, item: item, credentials: credentials)
                // Nothing accepted counts as a failure, or the same parts
                // would be asked for again at once.
                guard !sent.isDisjoint(with: parts) else { return .requestFailed(.transport(nil), clientUploadID: clientID) }
                return .partsUploaded(sent, sessionID: session.id)
            case .wait, .none:
                return nil
            }
        } catch let error as MomentsAPIError {
            return .requestFailed(error, clientUploadID: clientID)
        } catch is CancellationError {
            return nil
        } catch {
            return .requestFailed(.transport(nil), clientUploadID: clientID)
        }
    }

    private func apply(_ event: QueuedUpload.Event, to id: UUID) {
        guard var item = items[id] else { return }
        let before = item
        item.apply(event, now: now())
        guard item != before else { return }
        store(item)
        if case .done = item.phase { removeStagedFile(of: item) }
    }

    /// Keeps the item, saves it and tells the UI.
    private func store(_ item: QueuedUpload) {
        items[item.id] = item
        persist(item)
        publish()
    }

    private func persist(_ item: QueuedUpload) {
        do {
            try store.save(item)
        } catch {
            saveFailures += 1
        }
    }

    private func removeStagedFile(of item: QueuedUpload) {
        do {
            try staging.remove(item.file)
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
}
