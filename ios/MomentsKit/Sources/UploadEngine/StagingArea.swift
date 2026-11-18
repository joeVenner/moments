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
        /// Not a plain file (a folder, a link, a device, a hard link).
        case notAFile
        /// The file's size changed since it was staged.
        case sizeChanged
        /// Can't be checked right now (locked, permissions, I/O); try later.
        case unreadable
    }

    public let root: URL

    public init(root: URL) {
        self.root = root
    }

    /// The staged file, opened for reading parts after every check. The
    /// checks run on the open descriptor (`fstat`), not the path, so the
    /// file can't be swapped between checking and reading; keep the handle
    /// for the whole upload and treat a short read as a failure.
    public func open(_ file: QueuedUpload.StagedFile) throws(Problem) -> FileHandle {
        let candidate = Self.canonical(root.appending(path: file.relativePath, directoryHint: .notDirectory))
        guard isInside(candidate) else { throw .outsideStaging }

        switch FileReader.open(candidate) {
        case let .opened(handle, info):
            // One link only: a hard link would be another name for a file
            // that may belong elsewhere.
            guard info.isRegular, info.linkCount == 1 else { throw .notAFile }
            guard info.size == file.size else { throw .sizeChanged }
            return handle
        case .missing: throw .missing
        case .notAFile: throw .notAFile
        case .unreadable: throw .unreadable
        }
    }

    /// Deletes a staged file once its item is done or discarded. Only
    /// inside the folder; a link is removed itself, never its target.
    public func remove(_ file: QueuedUpload.StagedFile) throws(Problem) {
        let path = root.appending(path: file.relativePath, directoryHint: .notDirectory)
        guard isInside(Self.canonical(path)) else { throw .outsideStaging }
        guard unlink(path.path(percentEncoded: false)) == 0 || errno == ENOENT else { throw .unreadable }
    }

    private func isInside(_ candidate: URL) -> Bool {
        let basePath = Self.canonical(root).path(percentEncoded: false)
        let prefix = basePath.hasSuffix("/") ? basePath : basePath + "/"
        return candidate.path(percentEncoded: false).hasPrefix(prefix)
    }

    /// Symlinks resolved and `.`/`..` removed. Applied to both sides so
    /// system links (`/var` → `/private/var`) compare equal.
    private static func canonical(_ url: URL) -> URL {
        url.standardizedFileURL.resolvingSymlinksInPath()
    }
}
