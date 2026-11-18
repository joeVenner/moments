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

    public init(url: URL, kind: Kind) {
        self.url = url
        self.kind = kind
    }

    /// Where picked files wait to be prepared: in Caches, so they are never
    /// backed up and the system may reclaim them.
    public static var inbox: URL {
        URL.cachesDirectory.appending(path: "PickedMedia", directoryHint: .isDirectory)
    }

    /// Deletes everything in the inbox. Call at launch, before any import
    /// starts: copies left there belong to imports a crash interrupted.
    public static func clearInbox(_ folder: URL = inbox) {
        try? FileManager.default.removeItem(at: folder)
    }

    /// Copies a file the picker handed over into `folder` under a fresh
    /// name (keeping only a short, plain extension, which tells AVFoundation
    /// and ImageIO the format).
    static func adopt(_ received: URL, kind: Kind, into folder: URL = inbox) throws -> PickedMedia {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let ext = received.pathExtension.lowercased()
        let safeExt = ext.count <= 5 && !ext.isEmpty && ext.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) ? ext : "bin"
        let copy = folder.appending(path: "\(UUID().uuidString).\(safeExt)", directoryHint: .notDirectory)
        try FileManager.default.copyItem(at: received, to: copy)
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
        case cancelled
    }

    public static let photoName = "photo.jpg"
    public static let videoName = "video.mp4"

    /// Prepares `picked` into `folder` (created if needed, leftovers of an
    /// interrupted attempt swept first) and deletes the picked copy, whatever
    /// the outcome. A file already in the folder from an earlier attempt is
    /// replaced.
    public static func importMedia(
        _ picked: PickedMedia, into folder: URL,
        videoLimits: VideoPreparer.Limits = VideoPreparer.Limits()
    ) async throws(Problem) -> PreparedMedia {
        defer { try? FileManager.default.removeItem(at: picked.url) }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            throw .failed
        }
        PhotoPreparer.removeLeftovers(in: folder)
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

    /// `url`, with whatever an earlier attempt left there removed.
    private static func fresh(_ url: URL) throws(Problem) -> URL {
        do {
            try FileManager.default.removeItem(at: url)
        } catch CocoaError.fileNoSuchFile {
        } catch {
            throw .failed
        }
        return url
    }
}
