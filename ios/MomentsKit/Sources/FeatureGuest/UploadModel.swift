import Foundation
import MediaPipeline
import Observation
import UploadEngine

/// Hands a prepared upload to the queue (the app wraps `UploadQueue`).
public protocol UploadSubmitting: Sendable {
    func submit(_ upload: QueuedUpload) async throws
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

/// Cleans up what earlier runs left: picked originals (which still carry
/// location data) and half-written prepared files. Call once at launch,
/// before the upload screen can open.
public enum GuestUploadsLaunch {
    public static func clearLeftovers(staging: StagingArea? = nil) {
        PickedMedia.clearInbox()
        guard let staging else { return }
        let folders = (try? FileManager.default.contentsOfDirectory(at: staging.root, includingPropertiesForKeys: nil)) ?? []
        for folder in folders { PhotoPreparer.removeLeftovers(in: folder) }
    }
}

/// The guest's upload screen: picks are prepared one at a time as they
/// arrive, then shared together with an optional caption.
@MainActor @Observable
public final class UploadModel {
    public nonisolated static let maxCaptionLength = 500
    /// Picks per batch (the picker's selection limit).
    public static let maxPicks = 30

    public enum ItemState: Equatable, Sendable {
        /// Waiting for the picker or being prepared.
        case preparing
        case ready(PreparedMedia)
        case failed(MediaImporter.Problem)
        /// Handed to the queue.
        case shared
    }

    public struct Item: Identifiable, Equatable, Sendable {
        /// Also the queued upload's id and its staging folder's name.
        public let id: UUID
        public fileprivate(set) var kind: PickedMedia.Kind?
        public fileprivate(set) var state: ItemState

        /// Worth offering "Try again" (the pick is still held).
        public var canRetry: Bool {
            guard case let .failed(problem) = state else { return false }
            return [.failed, .cancelled, .noSpace].contains(problem)
        }
    }

    public enum ShareProblem: Error, Equatable, Sendable {
        /// The queue is full; some items weren't shared.
        case queueFull
        /// Something else went wrong; the items stay to try again.
        case failed
    }

    public private(set) var items: [Item] = []
    public var caption = ""
    public private(set) var isSharing = false
    public private(set) var shareProblem: ShareProblem?

    /// Any ready item is a video (its sound is uploaded too).
    public var hasVideo: Bool { items.contains { $0.kind == .video && $0.state != .shared } }
    public var readyCount: Int { items.filter { if case .ready = $0.state { true } else { false } }.count }
    public var isPreparing: Bool { items.contains { $0.state == .preparing } }
    public var canShare: Bool { readyCount > 0 && !isPreparing && !isSharing && Self.cleanCaption(caption) != nil }
    public var isCaptionTooLong: Bool { caption.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count > Self.maxCaptionLength }

    @ObservationIgnored private var picks: [UUID: PickedMedia] = [:]
    @ObservationIgnored private var queue: [(UUID, PickLoader?)] = []
    @ObservationIgnored private var worker: Task<Void, Never>?
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
    public func add(_ loaders: [PickLoader]) {
        let room = max(0, Self.maxPicks - items.filter { $0.state != .shared }.count)
        for loader in loaders.prefix(room) {
            let item = Item(id: UUID(), kind: nil, state: .preparing)
            items.append(item)
            queue.append((item.id, loader))
        }
        startWorker()
    }

    public func retry(_ id: UUID) {
        guard let index = items.firstIndex(where: { $0.id == id }), items[index].canRetry, picks[id] != nil else { return }
        items[index].state = .preparing
        queue.append((id, nil))
        startWorker()
    }

    /// Removes an item that isn't shared, with its files.
    public func remove(_ id: UUID) {
        guard let index = items.firstIndex(where: { $0.id == id }), items[index].state != .shared else { return }
        queue.removeAll { $0.0 == id }
        if items[index].state == .preparing, worker != nil, current == id {
            // Being prepared: cancelling the worker would stop the others
            // too; let it finish and drop the result.
            dropped.insert(id)
        } else {
            cleanUp(id)
        }
        items.remove(at: index)
    }

    /// Everything not shared is dropped (the screen was dismissed).
    public func discardAll() {
        for item in items where item.state != .shared {
            remove(item.id)
        }
    }

    /// Queues every ready item with the caption.
    public func share() async {
        guard canShare, let caption = Self.cleanCaption(caption) else { return }
        isSharing = true
        shareProblem = nil
        defer { isSharing = false }
        for index in items.indices {
            guard case let .ready(media) = items[index].state else { continue }
            let id = items[index].id
            guard let file = QueuedUpload.StagedFile(
                relativePath: StagingArea.relativePath(for: id, name: media.name),
                size: media.byteCount, contentType: media.contentType
            ) else {
                items[index].state = .failed(.tooLarge)
                cleanUp(id)
                continue
            }
            let upload = QueuedUpload(id: id, eventSlug: eventSlug, file: file, caption: caption.isEmpty ? nil : caption, createdAt: now())
            do {
                try await submitter.submit(upload)
                items[index].state = .shared
            } catch UploadQueue.EnqueueError.full {
                shareProblem = .queueFull
                return
            } catch {
                shareProblem = .failed
                return
            }
        }
        if !items.contains(where: { $0.state != .shared }) { self.caption = "" }
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

    @ObservationIgnored private var current: UUID?
    @ObservationIgnored private var dropped: Set<UUID> = []

    private func startWorker() {
        guard worker == nil else { return }
        worker = Task { [weak self] in
            while let self, let (id, loader) = self.nextJob() {
                await self.prepare(id, loader: loader)
            }
            self?.worker = nil
        }
    }

    private func nextJob() -> (UUID, PickLoader?)? {
        guard !queue.isEmpty else { current = nil; return nil }
        let job = queue.removeFirst()
        current = job.0
        return job
    }

    private func prepare(_ id: UUID, loader: PickLoader?) async {
        let picked: PickedMedia
        if let held = picks[id] {
            picked = held
        } else {
            guard let loader, let loaded = try? await loader() else {
                finish(id, .failed(.unsupported))
                return
            }
            picked = loaded
            picks[id] = loaded
            if let index = items.firstIndex(where: { $0.id == id }) { items[index].kind = loaded.kind }
        }
        do {
            let media = try await importer.importMedia(picked, into: staging.folder(for: id))
            // The importer deleted the pick.
            picks[id] = nil
            finish(id, .ready(media))
        } catch {
            if ![.failed, .cancelled, .noSpace].contains(error) { picks[id] = nil }
            finish(id, .failed(error))
        }
    }

    private func finish(_ id: UUID, _ state: ItemState) {
        if dropped.remove(id) != nil {
            cleanUp(id)
            return
        }
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].state = state
    }

    /// Deletes an unshared item's held pick and prepared files.
    private func cleanUp(_ id: UUID) {
        if let pick = picks.removeValue(forKey: id) { importer.discard(pick) }
        try? FileManager.default.removeItem(at: staging.folder(for: id))
    }
}

extension UploadModel: Identifiable {}
