import Foundation
import Observation
import OSLog
import UploadEngine

/// What the progress screen needs from the upload queue. `UploadQueue`
/// provides it; tests use a fake.
public protocol UploadProgressSource: Sendable {
    /// The whole queue now and after every change.
    func updates() async -> AsyncStream<[QueuedUpload]>
    func retry(id: UUID) async
    /// Removes a finished item (done or failed) and its file.
    func discard(id: UUID) async throws
    /// Removes every item that finished successfully.
    func clearDone() async throws
}

extension UploadQueue: UploadProgressSource {}

/// This event's uploads as the guest sees them.
@MainActor @Observable
public final class UploadProgressModel {
    public enum Status: Equatable, Sendable {
        /// Queued, or backing off before the next try (`retryAt` set).
        case waiting
        /// A large video held off mobile data until Wi-Fi.
        case waitingForWiFi
        /// Fraction of the file storage has, 0...1.
        case uploading(Double)
        /// Sent; the server is checking it.
        case finishing
        case done
        case failed(QueuedUpload.Failure, canRetry: Bool)
    }

    public struct Row: Identifiable, Equatable, Sendable {
        public let id: UUID
        public let isVideo: Bool
        public let caption: String?
        public let status: Status
    }

    public private(set) var rows: [Row] = []
    /// Neither done nor failed.
    public var activeCount: Int { rows.count { !$0.isFinished } }
    public var failedCount: Int { rows.count { if case .failed = $0.status { true } else { false } } }
    public var doneCount: Int { rows.count { $0.status == .done } }
    /// How far the batch is, 0...1, over the items that can still arrive
    /// (a failed one would otherwise fill the bar).
    public var overallFraction: Double {
        let counted = rows.filter { if case .failed = $0.status { false } else { true } }
        guard !counted.isEmpty else { return 0 }
        return counted.map(\.fraction).reduce(0, +) / Double(counted.count)
    }

    public enum Headline: Equatable, Sendable {
        case sharing(Int)
        case someFailed(Int)
        case allShared
    }

    /// The sheet's title: sharing wins while anything is moving; failures
    /// get their own line then (`failedCount`).
    public var headline: Headline {
        if activeCount > 0 { return .sharing(activeCount) }
        if failedCount > 0 { return .someFailed(failedCount) }
        return .allShared
    }
    /// A remove or clear failed (storage); cleared by the next one that works.
    public private(set) var couldNotRemove = false

    @ObservationIgnored private let eventSlug: String
    @ObservationIgnored private let source: any UploadProgressSource
    @ObservationIgnored private let network: (@Sendable () -> AsyncStream<Bool>)?
    @ObservationIgnored private let largeVideosOnWiFiOnly: @Sendable () -> Bool
    @ObservationIgnored private var queue: [QueuedUpload] = []
    @ObservationIgnored private var isOnExpensiveNetwork = false
    @ObservationIgnored private let logger = Logger(subsystem: "moments", category: "upload-progress")

    /// `network` starts a watch of whether the phone is on mobile data, one
    /// per `observe()` (nil: never known); with the guest's Wi-Fi choice it
    /// marks large videos as waiting.
    public init(
        eventSlug: String, source: any UploadProgressSource, network: (@Sendable () -> AsyncStream<Bool>)? = nil,
        largeVideosOnWiFiOnly: @escaping @Sendable () -> Bool = { CellularPolicy.largeVideosOnWiFiOnly() }
    ) {
        self.eventSlug = eventSlug
        self.source = source
        self.network = network
        self.largeVideosOnWiFiOnly = largeVideosOnWiFiOnly
    }

    /// The app's model: the network watched with `NWPathMonitor`.
    public static func live(eventSlug: String, source: any UploadProgressSource) -> UploadProgressModel {
        UploadProgressModel(eventSlug: eventSlug, source: source, network: { NetworkPath.expensiveUpdates() })
    }

    /// Follows the queue (and the network) until the queue ends or the
    /// calling task is cancelled (`.task`).
    public func observe() async {
        // A fresh watch each time: the last one ended with its task.
        let network = network?()
        await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                await self.followQueue()
                return true
            }
            if let network {
                group.addTask {
                    await self.followNetwork(network)
                    return false
                }
            }
            // The network never ends on its own: stop it with the queue.
            while let isQueue = await group.next() {
                if isQueue { group.cancelAll() }
            }
        }
    }

    private func followQueue() async {
        for await queue in await source.updates() {
            self.queue = queue.filter { $0.eventSlug == eventSlug }
            refreshRows()
        }
    }

    private func followNetwork(_ network: AsyncStream<Bool>) async {
        for await isExpensive in network {
            isOnExpensiveNetwork = isExpensive
            refreshRows()
        }
    }

    /// Re-reads the guest's Wi-Fi choice (after they change it).
    public func refresh() {
        refreshRows()
    }

    private func refreshRows() {
        let isHolding = isOnExpensiveNetwork && largeVideosOnWiFiOnly()
        rows = queue.map { Self.row($0, isHoldingLargeVideos: isHolding) }
    }

    public func retry(_ id: UUID) async {
        guard rows.first(where: { $0.id == id })?.canRetry == true else { return }
        await source.retry(id: id)
    }

    public func remove(_ id: UUID) async {
        guard rows.first(where: { $0.id == id })?.isFinished == true else { return }
        await perform { try await self.source.discard(id: id) }
    }

    public func clearDone() async {
        guard doneCount > 0 else { return }
        await perform { try await self.source.clearDone() }
    }

    private func perform(_ work: () async throws -> Void) async {
        do {
            try await work()
            couldNotRemove = false
        } catch {
            // The type only: file errors can carry staging paths.
            logger.error("removing uploads failed: \(String(describing: type(of: error)), privacy: .public)")
            couldNotRemove = true
        }
    }

    nonisolated static func row(_ item: QueuedUpload, isHoldingLargeVideos: Bool = false) -> Row {
        let isVideo = item.file.contentType.hasPrefix("video/")
        let isHeld = isHoldingLargeVideos && !CellularPolicy.allowsMobileData(
            contentType: item.file.contentType, size: item.file.size, largeVideosOnWiFiOnly: true
        )
        // Only while parts are still to send: checking and finishing talk
        // to the server, which mobile data allows.
        let isSending = switch item.phase {
        case .prepared, .uploading: true
        default: false
        }
        if isHeld, isSending {
            return Row(id: item.id, isVideo: isVideo, caption: item.caption, status: .waitingForWiFi)
        }
        // Backing off after a failed try: show it as waiting, not stuck mid-upload.
        if item.retryAt != nil, !item.isFinished {
            return Row(id: item.id, isVideo: isVideo, caption: item.caption, status: .waiting)
        }
        let status: Status = switch item.phase {
        case .prepared, .checking: item.session == nil || item.uploaded.isEmpty ? .waiting : .uploading(item.uploadedFraction)
        case .uploading: .uploading(item.uploadedFraction)
        case .finishing: .finishing
        case .done: .done
        case let .failed(failure): .failed(failure, canRetry: item.canRetryByGuest)
        }
        return Row(id: item.id, isVideo: isVideo, caption: item.caption, status: status)
    }
}

extension UploadProgressModel.Row {
    public var isFinished: Bool {
        switch status {
        case .done, .failed: true
        default: false
        }
    }

    /// This item's share of the way, 0...1.
    public var fraction: Double {
        switch status {
        case .waiting, .waitingForWiFi: 0
        case let .uploading(fraction): min(max(fraction, 0), 1)
        case .finishing, .done: 1
        case .failed: 0
        }
    }

    public var canRetry: Bool {
        if case .failed(_, true) = status { true } else { false }
    }
}
