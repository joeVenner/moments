import CoreTransferable
import Foundation
import UniformTypeIdentifiers

/// A photo or video the guest picked, as a file the app owns. PhotosPicker
/// hands a file that is deleted as soon as the import closure returns, so
/// it is copied into the inbox first; the importer deletes the copy once
/// the upload file is made.
public struct PickedMedia: Sendable, Equatable {
    public enum Kind: String, Sendable, Equatable {
        case photo, video
    }

    public let url: URL
    public let kind: Kind

    /// Internal: the importer deletes the file it is handed, so only files
    /// the app copied (`adopt`) may become picked media.
    init(url: URL, kind: Kind) {
        self.url = url
        self.kind = kind
    }

    /// Where picked files wait to be prepared: in Caches, so they are never
    /// backed up and the system may reclaim them.
    public static var inbox: URL {
        URL.cachesDirectory.appending(path: "PickedMedia", directoryHint: .isDirectory)
    }

    /// Deletes everything in the inbox. Call at launch, before the picker
    /// can be shown (it would delete live imports' files): copies left there
    /// belong to imports a crash interrupted or that failed for a reason
    /// worth retrying, and still carry their location data.
    public static func clearInbox(_ folder: URL = inbox) {
        try? FileManager.default.removeItem(at: folder)
    }

    /// Largest file accepted from the picker (the video preparer's source
    /// limit; photos are capped lower by their own preparer).
    static let maxReceivedBytes: Int64 = 4_000_000_000

    public enum AdoptError: Error, Equatable {
        /// A link, a folder, or anything but a plain file.
        case notAFile
        case tooLarge
        case noSpace
    }

    /// Copies a file the picker handed over into `folder` under a fresh
    /// name (keeping only a short, plain extension, which tells AVFoundation
    /// and ImageIO the format). The copy still carries the original's
    /// metadata, so the folder is out of backups and the copy protected.
    static func adopt(_ received: URL, kind: Kind, into folder: URL = inbox) throws -> PickedMedia {
        let values = try received.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, let size = values.fileSize else { throw AdoptError.notAFile }
        guard Int64(size) <= maxReceivedBytes else { throw AdoptError.tooLarge }
        try FileManager.default.createDirectory(
            at: folder, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        var exclusion = URLResourceValues()
        exclusion.isExcludedFromBackup = true
        var excluded = folder
        try excluded.setResourceValues(exclusion)
        // Room for the copy and the prepared file next to it.
        if let free = try? folder.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            .volumeAvailableCapacityForImportantUsage, free < Int64(size) * 2 {
            throw AdoptError.noSpace
        }
        let ext = received.pathExtension.lowercased()
        let safeExt = ext.count <= 5 && !ext.isEmpty && ext.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) ? ext : "bin"
        let copy = folder.appending(path: "\(UUID().uuidString).\(safeExt)", directoryHint: .notDirectory)
        do {
            // Never move: the picker may hand over the user's own file.
            try FileManager.default.copyItem(at: received, to: copy)
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: copy.path(percentEncoded: false)
            )
        } catch {
            try? FileManager.default.removeItem(at: copy)
            if (error as? CocoaError)?.code == .fileWriteOutOfSpace { throw AdoptError.noSpace }
            throw error
        }
        return PickedMedia(url: copy, kind: kind)
    }
}

extension PickedMedia: Transferable {
    public static var transferRepresentation: some TransferRepresentation {
        // Movies first: a Live Photo or a video also conforms to broader
        // types, and the picker uses the first one that matches.
        FileRepresentation(importedContentType: .movie) { received in
            try adopt(received.file, kind: .video)
        }
        FileRepresentation(importedContentType: .image) { received in
            try adopt(received.file, kind: .photo)
        }
    }
}

/// A prepared file in an item's staging folder, ready to queue.
public struct PreparedMedia: Sendable, Equatable {
    /// The file's name inside the item's folder.
    public let name: String
    public let contentType: String
    public let byteCount: Int64
    public let width: Int
    public let height: Int
    /// Nil for photos.
    public let duration: TimeInterval?
    /// The feed thumbnail beside it (`thumbnailName`), if one could be made.
    public internal(set) var thumbnail: Thumbnail?

    public struct Thumbnail: Sendable, Equatable {
        public let name: String
        public let byteCount: Int64
    }
}

/// Turns a picked file into the upload file in its item's folder.
public enum MediaImporter {
    /// What the guest is told, one case per kind of message.
    public enum Problem: Error, Equatable, Sendable {
        /// Not a photo or video the app can read (or damaged).
        case unsupported
        /// A photo with too many pixels, a video over 10 minutes, or a
        /// result over the upload limit.
        case tooLarge
        /// Preparing failed (often: the app went to the background during
        /// a video); worth trying again.
        case failed
        /// Videos only (photos are prepared in one go).
        case cancelled
        /// The phone is out of storage.
        case noSpace
        /// Another import into the same folder is running (a programming
        /// error: each item has its own folder and one import).
        case busy
    }

    public static let photoName = "photo.jpg"
    public static let videoName = "video.mp4"
    public static let thumbnailName = "thumb.jpg"

    /// Prepares `picked` into `folder` (the item's staging folder, created
    /// if needed and kept out of backups; leftovers of an interrupted
    /// attempt swept first). A file already there from an earlier attempt
    /// is replaced.
    ///
    /// The picked copy is deleted on success and when it can never work
    /// (`unsupported`, `tooLarge`); after `failed`, `cancelled` or `noSpace`
    /// it is kept so the same `picked` can be retried, and the caller
    /// deletes it (`discard`) when giving up — `clearInbox` at launch
    /// catches the rest. Only one import per folder may run at a time.
    public static func importMedia(
        _ picked: PickedMedia, into folder: URL,
        videoLimits: VideoPreparer.Limits = VideoPreparer.Limits()
    ) async throws(Problem) -> PreparedMedia {
        guard ActiveFolders.shared.claim(folder) else { throw .busy }
        defer { ActiveFolders.shared.release(folder) }
        do {
            let media = try await prepare(picked, into: folder, videoLimits: videoLimits)
            discard(picked)
            return media
        } catch {
            if error == .unsupported || error == .tooLarge { discard(picked) }
            throw error
        }
    }

    /// Deletes a picked copy that won't be imported.
    public static func discard(_ picked: PickedMedia) {
        try? FileManager.default.removeItem(at: picked.url)
    }

    private static func prepare(
        _ picked: PickedMedia, into folder: URL, videoLimits: VideoPreparer.Limits
    ) async throws(Problem) -> PreparedMedia {
        do {
            // Readable after first unlock, so a background wake while the
            // phone is locked can still send it; never only by inheritance.
            try FileManager.default.createDirectory(
                at: folder, withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
            )
            var exclusion = URLResourceValues()
            exclusion.isExcludedFromBackup = true
            var excluded = folder
            try excluded.setResourceValues(exclusion)
        } catch {
            throw (error as? CocoaError)?.code == .fileWriteOutOfSpace ? .noSpace : .failed
        }
        PhotoPreparer.removeLeftovers(in: folder)
        var media = try await prepareFile(picked, into: folder, videoLimits: videoLimits)
        media.thumbnail = await thumbnail(of: media, in: folder)
        return media
    }

    /// The feed thumbnail for a prepared file, or nil (never an error: the
    /// upload goes ahead without one). Only this result says a thumbnail
    /// exists: a `thumb.jpg` an earlier attempt left must never be trusted.
    private static func thumbnail(of media: PreparedMedia, in folder: URL) async -> PreparedMedia.Thumbnail? {
        guard let destination = try? fresh(folder.appending(path: thumbnailName, directoryHint: .notDirectory)) else { return nil }
        let file = folder.appending(path: media.name, directoryHint: .notDirectory)
        let byteCount = if media.duration == nil {
            ThumbnailMaker.fromPhoto(file, destination: destination)
        } else {
            await ThumbnailMaker.fromVideo(file, destination: destination)
        }
        return byteCount.map { PreparedMedia.Thumbnail(name: thumbnailName, byteCount: $0) }
    }

    private static func prepareFile(
        _ picked: PickedMedia, into folder: URL, videoLimits: VideoPreparer.Limits
    ) async throws(Problem) -> PreparedMedia {
        switch picked.kind {
        case .photo:
            let destination = try fresh(folder.appending(path: photoName, directoryHint: .notDirectory))
            do {
                let photo = try PhotoPreparer.prepare(source: picked.url, destination: destination)
                return PreparedMedia(
                    name: photoName, contentType: PreparedPhoto.contentType, byteCount: photo.byteCount,
                    width: photo.width, height: photo.height, duration: nil
                )
            } catch {
                switch error {
                case .unreadable: throw .unsupported
                case .tooLarge: throw .tooLarge
                case .writeFailed, .destinationExists: throw .failed
                }
            }
        case .video:
            let destination = try fresh(folder.appending(path: videoName, directoryHint: .notDirectory))
            do {
                let video = try await VideoPreparer.prepare(source: picked.url, destination: destination, limits: videoLimits)
                return PreparedMedia(
                    name: videoName, contentType: PreparedVideo.contentType, byteCount: video.byteCount,
                    width: video.width, height: video.height, duration: video.duration
                )
            } catch {
                switch error {
                case .unreadable: throw .unsupported
                case .tooLarge: throw .tooLarge
                case .cancelled: throw .cancelled
                case .exportFailed, .destinationExists: throw .failed
                }
            }
        }
    }

    /// `url`, with whatever an earlier attempt left there removed (a link
    /// is removed itself, never followed).
    private static func fresh(_ url: URL) throws(Problem) -> URL {
        let path = url.path(percentEncoded: false)
        var info = stat()
        guard lstat(path, &info) == 0 else { return url }
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            throw .failed
        }
        return url
    }
}

/// Folders with an import running, so two imports can't sweep or replace
/// each other's files.
final class ActiveFolders: @unchecked Sendable {
    static let shared = ActiveFolders()
    private let lock = NSLock()
    private var paths: Set<String> = []

    func claim(_ folder: URL) -> Bool {
        lock.withLock { paths.insert(folder.standardizedFileURL.path(percentEncoded: false)).inserted }
    }

    func release(_ folder: URL) {
        lock.withLock { _ = paths.remove(folder.standardizedFileURL.path(percentEncoded: false)) }
    }
}
