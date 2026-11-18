import Foundation
import MediaPipeline
import Observation
import UploadEngine

/// What the queue said to one upload.
public enum SubmitResult: Equatable, Sendable {
    /// Queued; the queue now owns the item's staging folder.
    case accepted
    /// Already queued (an earlier attempt got through): same as accepted.
    case duplicate
    /// The queue is full; try again later.
    case full
    /// The queue can't use this file; it never will.
    case invalid
    /// Anything else; worth trying again.
    case failed
}

/// Hands a prepared upload to the queue (the app adapts `UploadQueue`,
/// mapping its errors to `SubmitResult`).
public protocol UploadSubmitting: Sendable {
    func submit(_ upload: QueuedUpload) async -> SubmitResult
}

/// Prepares picked files (`MediaImporter` in the app; a fake in tests).
public protocol MediaImporting: Sendable {
    func importMedia(_ picked: PickedMedia, into folder: URL) async throws(MediaImporter.Problem) -> PreparedMedia
    func discard(_ picked: PickedMedia)
}

public struct LiveMediaImporter: MediaImporting {
    public init() {}

    public func importMedia(_ picked: PickedMedia, into folder: URL) async throws(MediaImporter.Problem) -> PreparedMedia {
        try await MediaImporter.importMedia(picked, into: folder)
    }

    public func discard(_ picked: PickedMedia) {
        MediaImporter.discard(picked)
    }
}

/// Loads one pick from the photo picker (`PhotosPickerItem.loadTransferable`).
/// Nil or a thrown error means the picker couldn't hand it over.
public typealias PickLoader = @Sendable () async throws -> PickedMedia?

/// Cleans up what earlier runs left: picked originals, which still carry
/// location data. Call once at launch, before the upload screen can open.
/// (Prepared files of items never queued are swept with the queue's ids
/// once uploads are wired.)
public enum GuestUploadsLaunch {
    public static func clearLeftovers() {
        PickedMedia.clearInbox()
    }
}

/// The guest's upload screen: picks are prepared one at a time as they
/// arrive, then shared together with an optional caption.
@MainActor @Observable
public final class UploadModel {
    public nonisolated static let maxCaptionLength = 500
    /// Picks per batch (the picker's selection limit).
    public static let maxPicks = 30
    /// Problems worth "Try again" (the pick, or how to load it, is kept).
    public nonisolated static let retryable: Set<MediaImporter.Problem> = [.failed, .cancelled, .noSpace]

    public enum ItemState: Equatable, Sendable {
        /// Waiting for the picker or being prepared.
        case preparing
        case ready(PreparedMedia)
        case failed(MediaImporter.Problem)
        /// Handed to the queue, which now owns its files.
        case shared
    }

    public struct Item: Identifiable, Equatable, Sendable {
        /// Also the queued upload's id and its staging folder's name.
        public let id: UUID
        public fileprivate(set) var kind: PickedMedia.Kind?
        public fileprivate(set) var state: ItemState

        /// Worth offering "Try again".
        public var canRetry: Bool {
            guard case let .failed(problem) = state else { return false }
            return UploadModel.retryable.contains(problem)
        }
    }

    public enum ShareProblem: Error, Equatable, Sendable {
        /// The queue is full; the rest weren't shared.
        case queueFull
        /// Something else went wrong; the rest stay to try again.
        case failed
    }

    public private(set) var items: [Item] = []
    /// A batch uses the caption as it was on Share (the screen also locks
    /// the field while sharing).
    public var caption = ""
    public private(set) var isSharing = false
    public private(set) var shareProblem: ShareProblem?

    /// A video that will be shared (its sound is uploaded too).
    public var hasVideo: Bool { items.contains { $0.kind == .video && $0.state != .shared } }
    public var readyCount: Int { items.filter { if case .ready = $0.state { true } else { false } }.count }
    public var isPreparing: Bool { items.contains { $0.state == .preparing } }
    /// Picks that can still be added.
    public var remainingSlots: Int { max(0, Self.maxPicks - items.filter { $0.state != .shared }.count) }
    public var canShare: Bool { readyCount > 0 && !isPreparing && !isSharing && Self.cleanCaption(caption) != nil }
    public var isCaptionTooLong: Bool { caption.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count > Self.maxCaptionLength }
    /// Holds characters the server refuses (tabs and other controls).
    public var captionHasInvalidCharacters: Bool { !isCaptionTooLong && Self.cleanCaption(caption) == nil }

    /// Picks loaded but not yet prepared (or kept to retry).
    @ObservationIgnored private var picks: [UUID: PickedMedia] = [:]
    /// How to load each pick, kept until it's loaded (to retry a picker
    /// failure).
    @ObservationIgnored private var loaders: [UUID: PickLoader] = [:]
    @ObservationIgnored private var pending: [UUID] = []
    @ObservationIgnored private var worker: Task<Void, Never>?
    /// The pick being prepared, and its task (cancelled when it's removed).
    @ObservationIgnored private var current: (id: UUID, task: Task<Void, Never>)?
    @ObservationIgnored private var isDiscarded = false
    @ObservationIgnored private let eventSlug: String
    @ObservationIgnored private let staging: StagingArea
    @ObservationIgnored private let importer: any MediaImporting
    @ObservationIgnored private let submitter: any UploadSubmitting
    @ObservationIgnored private let now: @Sendable () -> Date

    public init(
        eventSlug: String, staging: StagingArea, importer: any MediaImporting = LiveMediaImporter(),
        submitter: any UploadSubmitting, now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.eventSlug = eventSlug
        self.staging = staging
        self.importer = importer
        self.submitter = submitter
        self.now = now
    }

    /// New picks from the picker, prepared in order, one at a time (a
    /// video export and several large photos at once would exhaust memory).
    public func add(_ newLoaders: [PickLoader]) {
        guard !isSharing, !isDiscarded else { return }
        for loader in newLoaders.prefix(remainingSlots) {
            let item = Item(id: UUID(), kind: nil, state: .preparing)
            items.append(item)
            loaders[item.id] = loader
            pending.append(item.id)
        }
        startWorker()
    }

    public func retry(_ id: UUID) {
        guard !isSharing, let index = items.firstIndex(where: { $0.id == id }), items[index].canRetry,
              picks[id] != nil || loaders[id] != nil
        else { return }
        items[index].state = .preparing
        pending.append(id)
        startWorker()
    }

    /// Removes an item that isn't shared, with its files. Not while sharing
    /// (the queue may be taking it).
    public func remove(_ id: UUID) {
        guard !isSharing, let index = items.firstIndex(where: { $0.id == id }), items[index].state != .shared else { return }
        let wasPreparing = items[index].state == .preparing
        items.remove(at: index)
        pending.removeAll { $0 == id }
        // Only a pick its job is still preparing is left to the job.
        if wasPreparing, current?.id == id {
            // Stops a video export; the job cleans up when it ends.
            current?.task.cancel()
        } else {
            cleanUp(id)
        }
    }

    /// The screen closed: everything not shared is dropped and preparing
    /// stops. While sharing, this happens once the share ends.
    public func discardAll() {
        isDiscarded = true
        guard !isSharing else { return }
        pending.removeAll()
        current?.task.cancel()
        for item in items where item.state != .shared {
            items.removeAll { $0.id == item.id }
            if !(item.state == .preparing && current?.id == item.id) { cleanUp(item.id) }
        }
    }

    /// Queues every ready item with the caption.
    public func share() async {
        guard canShare, let caption = Self.cleanCaption(caption) else { return }
        isSharing = true
        shareProblem = nil
        // The batch as it is now; items are looked up by id (nothing can be
        // removed meanwhile, but stay safe).
        let batch: [(UUID, PreparedMedia)] = items.compactMap { item in
            if case let .ready(media) = item.state { (item.id, media) } else { nil }
        }
        loop: for (id, media) in batch {
            guard let file = QueuedUpload.StagedFile(
                relativePath: StagingArea.relativePath(for: id, name: media.name),
                size: media.byteCount, contentType: media.contentType
            ) else {
                setState(.failed(.tooLarge), of: id)
                cleanUp(id)
                continue
            }
            let upload = QueuedUpload(id: id, eventSlug: eventSlug, file: file, caption: caption.isEmpty ? nil : caption, createdAt: now())
            switch await submitter.submit(upload) {
            case .accepted, .duplicate:
                setState(.shared, of: id)
            case .invalid:
                setState(.failed(.unsupported), of: id)
                cleanUp(id)
            case .full:
                shareProblem = .queueFull
                break loop
            case .failed:
                shareProblem = .failed
                break loop
            }
        }
        isSharing = false
        if !items.contains(where: { $0.state != .shared }) { self.caption = "" }
        if isDiscarded { discardAll() }
    }

    /// The caption as sent: trimmed, nil when too long (in UTF-16 units, as
    /// the server counts) or holding control characters other than line
    /// breaks, as the server checks.
    nonisolated static func cleanCaption(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf16.count <= maxCaptionLength else { return nil }
        let allowed = trimmed.unicodeScalars.allSatisfy { scalar in
            scalar == "\n" || scalar == "\r" || !(scalar.value < 0x20 || scalar.value == 0x7F)
        }
        return allowed ? trimmed : nil
    }

    // MARK: - Preparing

    private func startWorker() {
        guard worker == nil else { return }
        worker = Task { [weak self] in
            while let self, !self.isDiscarded, !self.pending.isEmpty {
                let id = self.pending.removeFirst()
                // `current` is cleared inside the job, so it never outlives it.
                let job = Task {
                    await self.prepare(id)
                    self.current = nil
                }
                self.current = (id, job)
                await job.value
            }
            self?.worker = nil
        }
    }

    private func prepare(_ id: UUID) async {
        var picked = picks[id]
        if picked == nil, let loader = loaders[id] {
            do {
                picked = try await loader()
            } catch {
                // The picker couldn't hand it over (an iCloud download that
                // failed, say): keep the loader to try again.
                if isGone(id) { return finishGone(id) }
                return setState(.failed(.failed), of: id)
            }
            loaders[id] = nil
            if let picked { picks[id] = picked }
        }
        guard let picked else {
            if isGone(id) { return finishGone(id) }
            return setState(.failed(.unsupported), of: id)
        }
        if let index = items.firstIndex(where: { $0.id == id }) { items[index].kind = picked.kind }
        // Removed (or the screen closed) while loading: don't prepare it.
        if isGone(id) { return finishGone(id) }
        do {
            let media = try await importer.importMedia(picked, into: staging.folder(for: id))
            picks[id] = nil
            if isGone(id) { return finishGone(id) }
            setState(.ready(media), of: id)
        } catch {
            if !Self.retryable.contains(error) {
                picks[id] = nil
                // The importer keeps the pick for these; nothing else will.
                if error == .busy { importer.discard(picked) }
            }
            if isGone(id) { return finishGone(id) }
            setState(.failed(error), of: id)
        }
    }

    private func isGone(_ id: UUID) -> Bool {
        Task.isCancelled || !items.contains { $0.id == id }
    }

    private func finishGone(_ id: UUID) {
        if items.contains(where: { $0.id == id }) {
            // Cancelled with the item still listed: the screen is closing.
            items.removeAll { $0.id == id }
        }
        cleanUp(id)
    }

    private func setState(_ state: ItemState, of id: UUID) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].state = state
    }

    /// Deletes an unshared item's held pick and prepared files.
    private func cleanUp(_ id: UUID) {
        loaders[id] = nil
        if let pick = picks.removeValue(forKey: id) { importer.discard(pick) }
        try? FileManager.default.removeItem(at: staging.folder(for: id))
    }
}

extension UploadModel: Identifiable {}
