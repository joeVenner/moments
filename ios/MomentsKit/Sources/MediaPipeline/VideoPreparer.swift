@preconcurrency import AVFoundation
import Foundation

/// A video made ready to upload.
public struct PreparedVideo: Sendable, Equatable {
    public static let contentType = "video/mp4"

    /// Display size (rotation applied).
    public let width: Int
    public let height: Int
    public let duration: TimeInterval
    /// Size of the written file.
    public let byteCount: Int64

    public init(width: Int, height: Int, duration: TimeInterval, byteCount: Int64) {
        self.width = width
        self.height = height
        self.duration = duration
        self.byteCount = byteCount
    }
}

/// Turns a picked video into the MP4 that is uploaded: H.264 at most
/// 1920×1080 (never enlarged), optimized for streaming, and carrying no
/// metadata — no location, device, software or capture time. It is always
/// re-encoded, so nothing of the source container survives but its tracks.
public enum VideoPreparer {
    public enum Problem: Error, Equatable, Sendable {
        /// Not a video AVFoundation can read, or no video track.
        case unreadable
        /// Longer than allowed, or the result is larger than uploads allow.
        case tooLarge
        /// The export failed or couldn't be written.
        case exportFailed
        /// Something already exists at the destination.
        case destinationExists
    }

    public struct Limits: Sendable {
        /// Longest accepted video.
        public var duration: TimeInterval
        /// Size of the source file.
        public var sourceBytes: Int64
        /// Size of the prepared file (the server's upload limit).
        public var outputBytes: Int64

        public init(duration: TimeInterval = 10 * 60, sourceBytes: Int64 = 4_000_000_000, outputBytes: Int64 = 512 * 1024 * 1024) {
            self.duration = duration
            self.sourceBytes = sourceBytes
            self.outputBytes = outputBytes
        }
    }

    /// Reads the video at `source` and writes the upload MP4 to
    /// `destination`, which must not exist. Nothing is left at
    /// `destination` unless it succeeds. Cancelling the task cancels the
    /// export. The caller deletes the source afterwards.
    public static func prepare(source: URL, destination: URL, limits: Limits = Limits()) async throws(Problem) -> PreparedVideo {
        let size = (try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init)
        guard let size else { throw .unreadable }
        guard size <= limits.sourceBytes else { throw .tooLarge }
        let asset = AVURLAsset(url: source, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let duration: CMTime
        do {
            let (isReadable, length) = try await asset.load(.isReadable, .duration)
            guard isReadable, try await !asset.loadTracks(withMediaType: .video).isEmpty else { throw Problem.unreadable }
            duration = length
        } catch {
            throw .unreadable
        }
        guard duration.isNumeric, duration.seconds > 0 else { throw .unreadable }
        guard duration.seconds <= limits.duration else { throw .tooLarge }

        let temporary = destination.deletingLastPathComponent()
            .appending(path: ".\(UUID().uuidString).preparing.mp4", directoryHint: .notDirectory)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try await export(asset, to: temporary)

        let written = AVURLAsset(url: temporary)
        let prepared: PreparedVideo
        do {
            guard let outTrack = try await written.loadTracks(withMediaType: .video).first else { throw Problem.exportFailed }
            let (natural, transform) = try await outTrack.load(.naturalSize, .preferredTransform)
            let shown = natural.applying(transform)
            let outDuration = try await written.load(.duration)
            let bytes = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            prepared = PreparedVideo(
                width: Int(abs(shown.width).rounded()), height: Int(abs(shown.height).rounded()),
                duration: outDuration.seconds, byteCount: Int64(bytes)
            )
        } catch {
            throw .exportFailed
        }
        guard prepared.byteCount <= limits.outputBytes else { throw .tooLarge }
        do {
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: temporary.path(percentEncoded: false)
            )
            try FileManager.default.moveItem(at: temporary, to: destination)
        } catch {
            if (error as? CocoaError)?.code == .fileWriteFileExists { throw .destinationExists }
            throw .exportFailed
        }
        return prepared
    }

    /// Re-encodes to H.264 within 1920×1080 with no metadata.
    static func export(_ asset: AVURLAsset, to url: URL) async throws(Problem) {
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset1920x1080) else {
            throw .exportFailed
        }
        session.outputURL = url
        session.outputFileType = .mp4
        session.shouldOptimizeForNetworkUse = true
        // No container metadata at all, and the sharing filter on top
        // (drops location and anything personal that could come through
        // per track).
        session.metadata = []
        session.metadataItemFilter = .forSharing()
        let box = SessionBox(session)
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                box.session.exportAsynchronously { continuation.resume() }
            }
        } onCancel: {
            box.session.cancelExport()
        }
        guard session.status == .completed else { throw .exportFailed }
    }
}

/// Carries the export session across the cancellation handler.
private final class SessionBox: @unchecked Sendable {
    let session: AVAssetExportSession
    init(_ session: AVAssetExportSession) { self.session = session }
}
