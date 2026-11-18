import Foundation

/// The folder holding prepared files waiting to upload. Maps a record's
/// `StagedFile` to a real file and refuses anything that resolves outside
/// the folder (a tampered record or a planted symlink) or no longer matches
/// the recorded size (part ranges would then send the wrong bytes).
public struct StagingArea: Sendable {
    public enum Problem: Error, Equatable, Sendable {
        /// The path leaves the staging folder once symlinks are resolved.
        case outsideStaging
        /// No file there.
        case missing
        /// Not a plain file (a folder, a link, a device).
        case notAFile
        /// The file's size changed since it was staged.
        case sizeChanged
    }

    public let root: URL

    public init(root: URL) {
        self.root = root
    }

    /// The file to read parts from, after every check.
    public func url(for file: QueuedUpload.StagedFile) throws(Problem) -> URL {
        let base = Self.canonical(root)
        let candidate = Self.canonical(root.appending(path: file.relativePath, directoryHint: .notDirectory))
        let basePath = base.path(percentEncoded: false)
        let prefix = basePath.hasSuffix("/") ? basePath : basePath + "/"
        guard candidate.path(percentEncoded: false).hasPrefix(prefix) else { throw .outsideStaging }

        let attributes: [FileAttributeKey: Any]
        do {
            attributes = try FileManager.default.attributesOfItem(atPath: candidate.path(percentEncoded: false))
        } catch {
            throw .missing
        }
        guard attributes[.type] as? FileAttributeType == .typeRegular else { throw .notAFile }
        guard (attributes[.size] as? NSNumber)?.int64Value == file.size else { throw .sizeChanged }
        return candidate
    }

    /// Symlinks resolved and `.`/`..` removed. Applied to both sides so
    /// system links (`/var` → `/private/var`) compare equal.
    private static func canonical(_ url: URL) -> URL {
        url.standardizedFileURL.resolvingSymlinksInPath()
    }
}
