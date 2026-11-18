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
/// re-encoded, so only the video and audio tracks of the source survive.
/// The export alone isn't enough (it keeps the capture date), so the
/// finished file is also scrubbed: every metadata box blanked and the
/// header times zeroed (`MP4Scrub`).
///
/// Not yet checked on a device: HDR (HLG/Dolby Vision) sources should come
/// out as SDR Rec. 709, and slow-motion clips as picked.
public enum VideoPreparer {
    public enum Problem: Error, Equatable, Sendable {
        /// Not a video AVFoundation can read, or no video track.
        case unreadable
        /// Longer than allowed, or the result would be larger than uploads
        /// allow.
        case tooLarge
        /// The export failed or couldn't be written (often: the app went
        /// to the background mid-export; worth trying again).
        case exportFailed
        /// Something already exists at the destination.
        case destinationExists
        /// The task was cancelled.
        case cancelled
    }

    public struct Limits: Sendable {
        /// Longest accepted video.
        public var duration: TimeInterval
        /// Size of the source file.
        public var sourceBytes: Int64
        /// Size of the prepared file (the server's upload limit). The
        /// export stops when it reaches it.
        public var outputBytes: Int64

        public init(duration: TimeInterval = 10 * 60, sourceBytes: Int64 = 4_000_000_000, outputBytes: Int64 = 512 * 1024 * 1024) {
            self.duration = duration
            self.sourceBytes = sourceBytes
            self.outputBytes = outputBytes
        }
    }

    /// Reads the video at `source` and writes the upload MP4 to
    /// `destination`, which must not exist. Nothing is left at
    /// `destination` unless it succeeds; a crash leaves at most a hidden
    /// `.preparing` file that `PhotoPreparer.removeLeftovers(in:)` deletes.
    /// The caller deletes the source afterwards.
    public static func prepare(source: URL, destination: URL, limits: Limits = Limits()) async throws(Problem) -> PreparedVideo {
        guard !FileManager.default.fileExists(atPath: destination.path(percentEncoded: false)) else { throw .destinationExists }
        guard let size = (try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) else { throw .unreadable }
        guard size <= limits.sourceBytes else { throw .tooLarge }
        let asset = AVURLAsset(url: source, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let duration: CMTime
        do {
            let (isReadable, length) = try await asset.load(.isReadable, .duration)
            let videoTracks = try await asset.loadTracks(withMediaType: .video)
            guard isReadable, !videoTracks.isEmpty else { throw Problem.unreadable }
            duration = length
        } catch {
            throw Task.isCancelled ? .cancelled : .unreadable
        }
        guard duration.isNumeric, duration.seconds > 0 else { throw .unreadable }
        guard duration.seconds <= limits.duration else { throw .tooLarge }

        let temporary = destination.deletingLastPathComponent()
            .appending(path: ".\(UUID().uuidString).preparing", directoryHint: .notDirectory)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try await export(asset, to: temporary, limit: limits.outputBytes)

        let prepared: PreparedVideo
        do {
            // The temporary name has no extension to tell the type by.
            let written = AVURLAsset(url: temporary, options: [AVURLAssetOverrideMIMETypeKey: PreparedVideo.contentType])
            guard let track = try await written.loadTracks(withMediaType: .video).first,
                  let bytes = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize
            else { throw Problem.exportFailed }
            let (natural, transform) = try await track.load(.naturalSize, .preferredTransform)
            let shown = natural.applying(transform)
            let outDuration = try await written.load(.duration)
            prepared = PreparedVideo(
                width: Int(abs(shown.width).rounded()), height: Int(abs(shown.height).rounded()),
                duration: outDuration.seconds, byteCount: Int64(bytes)
            )
        } catch {
            throw .exportFailed
        }
        // The length limit cuts the export short rather than failing it.
        guard prepared.byteCount < limits.outputBytes, prepared.duration >= duration.seconds - 0.5 else { throw .tooLarge }
        do {
            try MP4Scrub.scrub(temporary)
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
    static func export(_ asset: AVURLAsset, to url: URL, limit: Int64) async throws(Problem) {
        guard !Task.isCancelled else { throw .cancelled }
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset1920x1080) else {
            throw .exportFailed
        }
        session.shouldOptimizeForNetworkUse = true
        session.fileLengthLimit = limit
        // No container metadata at all, and the sharing filter on top
        // (drops location and anything personal that could come through
        // per track).
        session.metadata = []
        session.metadataItemFilter = .forSharing()
        if #available(iOS 18, macOS 15, *) {
            do {
                try await session.export(to: url, as: .mp4)
            } catch {
                throw Task.isCancelled ? .cancelled : .exportFailed
            }
            return
        }
        session.outputURL = url
        session.outputFileType = .mp4
        // cancelExport is safe from any thread; the session is read again
        // only after the export finished.
        let box = SessionBox(session)
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                box.session.exportAsynchronously { continuation.resume() }
            }
        } onCancel: {
            box.session.cancelExport()
        }
        if Task.isCancelled || session.status == .cancelled { throw .cancelled }
        guard session.status == .completed else { throw .exportFailed }
    }
}

/// Carries the export session across the cancellation handler.
private final class SessionBox: @unchecked Sendable {
    let session: AVAssetExportSession
    init(_ session: AVAssetExportSession) { self.session = session }
}

/// Removes what an export leaves behind in an MP4's movie box: every
/// metadata box (`udta`, `meta`) at movie or track level becomes a zeroed
/// `free` box (same size, so nothing else moves), and the creation and
/// modification times in the movie, track and media headers (`mvhd`,
/// `tkhd`, `mdhd`) are zeroed.
enum MP4Scrub {
    enum Problem: Error { case malformed }

    static func scrub(_ url: URL) throws {
        let handle = try FileHandle(forUpdating: url)
        defer { try? handle.close() }
        let end = try handle.seekToEnd()
        var offset: UInt64 = 0
        var found = false
        while offset + 8 <= end {
            try handle.seek(toOffset: offset)
            guard let header = try handle.read(upToCount: 16), header.count >= 8 else { throw Problem.malformed }
            var size = header.bigEndian(at: 0, count: 4)
            let type = String(decoding: header[4 ..< 8], as: UTF8.self)
            var headerLength: UInt64 = 8
            if size == 1 {
                guard header.count >= 16 else { throw Problem.malformed }
                size = header.bigEndian(at: 8, count: 8)
                headerLength = 16
            } else if size == 0 {
                size = end - offset
            }
            guard size >= headerLength, size <= end - offset else { throw Problem.malformed }
            if type == "udta" || type == "meta" {
                // Top-level metadata, outside the movie box.
                try blank(handle, at: offset, size: size, headerLength: headerLength)
            } else if type == "moov" {
                // The movie box only holds the index; it is small.
                guard size <= 64 * 1024 * 1024 else { throw Problem.malformed }
                try handle.seek(toOffset: offset)
                guard var movie = try handle.read(upToCount: Int(size)), movie.count == Int(size) else { throw Problem.malformed }
                try scrubBoxes(in: &movie, from: Int(headerLength), to: movie.count)
                try handle.seek(toOffset: offset)
                try handle.write(contentsOf: movie)
                found = true
            }
            offset += size
        }
        guard found else { throw Problem.malformed }
        try handle.synchronize()
    }

    /// Walks the boxes in `data[start..<end]`, descending into the ones
    /// that hold tracks and headers.
    static func scrubBoxes(in data: inout Data, from start: Int, to end: Int) throws {
        var offset = start
        while offset + 8 <= end {
            let size = Int(data.bigEndian(at: offset, count: 4))
            let type = String(decoding: data[(data.startIndex + offset + 4) ..< (data.startIndex + offset + 8)], as: UTF8.self)
            // Size 0 or 1 (to the end / 64-bit) never occurs inside the
            // movie box of an exported file; refuse rather than guess.
            guard size >= 8, size <= end - offset else { throw Problem.malformed }
            let first = data.startIndex + offset
            switch type {
            case "trak", "mdia":
                try scrubBoxes(in: &data, from: offset + 8, to: offset + size)
            case "udta", "meta":
                data.replaceSubrange(first + 4 ..< first + size, with: Data("free".utf8) + Data(count: size - 8))
            case "mvhd", "tkhd", "mdhd":
                // Full box: version (1 byte), flags (3), then creation and
                // modification times, 4 bytes each (version 0) or 8 (1).
                guard size >= 12 else { throw Problem.malformed }
                let width = data[first + 8] == 1 ? 16 : 8
                guard 12 + width <= size else { throw Problem.malformed }
                data.replaceSubrange(first + 12 ..< first + 12 + width, with: Data(count: width))
            default:
                break
            }
            offset += size
        }
    }

    private static func blank(_ handle: FileHandle, at offset: UInt64, size: UInt64, headerLength: UInt64) throws {
        try handle.seek(toOffset: offset + 4)
        try handle.write(contentsOf: Data("free".utf8))
        var left = size - headerLength
        try handle.seek(toOffset: offset + headerLength)
        let chunk = Data(count: 1 << 16)
        while left > 0 {
            let count = Int(min(left, UInt64(chunk.count)))
            try handle.write(contentsOf: chunk.prefix(count))
            left -= UInt64(count)
        }
    }
}

extension Data {
    fileprivate func bigEndian(at offset: Int, count: Int) -> UInt64 {
        var value: UInt64 = 0
        for byte in self[(startIndex + offset) ..< (startIndex + offset + count)] {
            value = value << 8 | UInt64(byte)
        }
        return value
    }
}
