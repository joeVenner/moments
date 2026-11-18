import Foundation

/// The folder holding prepared files waiting to upload, one sub-folder per
/// item. Maps a record's `StagedFile` to a real file and refuses anything
/// outside its item's folder (a tampered record or a planted symlink) or
/// that no longer matches the recorded size (part ranges would then send
/// the wrong bytes).
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

    /// The folder an item's staged files live in: `<root>/<ITEM-UUID>/`.
    /// Binding files to their item means a record (tampered or buggy) can't
    /// name another item's file.
    public func folder(for owner: UUID) -> URL {
        root.appending(path: owner.uuidString, directoryHint: .isDirectory)
    }

    /// The relative path for a file named `name` in the owner's folder.
    public static func relativePath(for owner: UUID, name: String) -> String {
        "\(owner.uuidString)/\(name)"
    }

    /// The staged file, opened for reading parts after every check. It must
    /// sit in its owner's folder with no link on the way: the parent folder
    /// is resolved and must still be the owner's, and the file itself is
    /// opened without following a link. The remaining checks run on the
    /// open descriptor (`fstat`), so the file can't be swapped between
    /// checking and reading; keep the handle for the whole upload and treat
    /// a short read as a failure.
    public func open(_ file: QueuedUpload.StagedFile, owner: UUID) throws(Problem) -> FileHandle {
        let path = try resolvedPath(of: file, owner: owner)
        switch FileReader.open(path) {
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

    /// Deletes a staged file once its item is done or discarded, under the
    /// same rules as `open`. A link in its place is removed itself, never
    /// its target.
    public func remove(_ file: QueuedUpload.StagedFile, owner: UUID) throws(Problem) {
        let path = try resolvedPath(of: file, owner: owner)
        guard unlink(path.path(percentEncoded: false)) == 0 || errno == ENOENT else { throw .unreadable }
    }

    /// The file's path with its parent folder resolved, if that folder is
    /// (inside) the owner's. The last component is left as is.
    private func resolvedPath(of file: QueuedUpload.StagedFile, owner: UUID) throws(Problem) -> URL {
        let ownerPrefix = owner.uuidString + "/"
        guard file.relativePath.hasPrefix(ownerPrefix) else { throw .outsideStaging }
        let path = root.appending(path: file.relativePath, directoryHint: .notDirectory)
        let parent = Self.canonical(path.deletingLastPathComponent())
        let base = Self.canonical(root).path(percentEncoded: false)
        let ownerBase = (base.hasSuffix("/") ? base : base + "/") + owner.uuidString
        let parentPath = parent.path(percentEncoded: false)
        let trimmed = parentPath.hasSuffix("/") ? String(parentPath.dropLast()) : parentPath
        guard trimmed == ownerBase || trimmed.hasPrefix(ownerBase + "/") else { throw .outsideStaging }
        return parent.appending(path: path.lastPathComponent, directoryHint: .notDirectory)
    }

    // MARK: Part files

    /// Where part files are written while they upload: `<root>/.parts/`,
    /// apart from the items' folders and wiped at every launch, so a part
    /// left by a crash (photo bytes) never outlives the next start. Created
    /// readable after first unlock and excluded from backup; refused if it
    /// is a link.
    public func partsFolder() throws(Problem) -> URL {
        let folder = root.appending(path: ".parts", directoryHint: .isDirectory)
        // No trailing slash: with one, lstat would follow a link.
        let path = root.appending(path: ".parts", directoryHint: .notDirectory).path(percentEncoded: false)
        var status = stat()
        // Checked before anything is set on it, and again after creating.
        if lstat(path, &status) == 0, status.st_mode & S_IFMT != S_IFDIR { throw .outsideStaging }
        do {
            try FileManager.default.createDirectory(
                at: folder, withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
            )
            // createDirectory skips attributes for an existing folder.
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path
            )
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var url = folder
            try url.setResourceValues(values)
        } catch {
            throw .unreadable
        }
        guard lstat(path, &status) == 0 else { throw .unreadable }
        guard status.st_mode & S_IFMT == S_IFDIR else { throw .outsideStaging }
        return folder
    }

    /// Deletes every part file. Call only at launch, before anything
    /// uploads, from the one process that owns the queue (a background
    /// session in another process must not be running then). Removes a link
    /// in the folder's place without following it.
    public func clearPartFiles() throws {
        let folder = root.appending(path: ".parts", directoryHint: .isDirectory)
        do {
            try FileManager.default.removeItem(at: folder)
        } catch CocoaError.fileNoSuchFile {
            return
        }
    }

    /// Symlinks resolved and `.`/`..` removed. Applied to both sides so
    /// system links (`/var` → `/private/var`) compare equal.
    private static func canonical(_ url: URL) -> URL {
        url.standardizedFileURL.resolvingSymlinksInPath()
    }
}
