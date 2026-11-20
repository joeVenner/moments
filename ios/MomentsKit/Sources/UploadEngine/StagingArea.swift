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

    /// `Application Support/UploadStaging` in the app's own container (the
    /// App Clip's is in the App Group: `UploadFolders.clip`), readable after first unlock
    /// and excluded from backup: it holds photo and video bytes.
    public static func appDefault(fileManager: FileManager = .default) throws -> StagingArea {
        let support = try fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return try prepared(root: support.appending(path: "UploadStaging", directoryHint: .isDirectory), fileManager: fileManager)
    }

    /// A staging folder at `root`, created if needed, with the same
    /// protection and backup exclusion as the app's.
    public static func prepared(root: URL, fileManager: FileManager = .default) throws -> StagingArea {
        var root = root
        let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true, attributes: protection)
        // createDirectory skips attributes for an existing folder.
        try fileManager.setAttributes(protection, ofItemAtPath: root.path(percentEncoded: false))
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try root.setResourceValues(values)
        return StagingArea(root: root)
    }

    /// Deletes item folders (`<UUID>/`) that no queue record owns: files
    /// prepared by a run that ended before queueing them, and folders of
    /// records `QueueStore.load()` set aside as unusable (they can never
    /// upload). Only folders created before `cutoff` (the launch) go, so one
    /// being prepared right now is safe. That test uses creation dates: a
    /// clock set back during the run could make a new folder look older, and
    /// its upload would then fail as missing. Pass every record id on disk
    /// (`QueueStore.recordIDs()`), not only the loaded ones. A link in a
    /// folder's place is removed itself, never its target; other names are
    /// left alone. Returns how many were removed.
    @discardableResult
    public func sweepItemFolders(keeping owners: Set<UUID>, createdBefore cutoff: Date) throws -> Int {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: root.path(percentEncoded: false)) else { return 0 }
        var removed = 0
        for name in try fileManager.contentsOfDirectory(atPath: root.path(percentEncoded: false)) {
            guard let id = UUID(uuidString: name), name == id.uuidString, !owners.contains(id) else { continue }
            let path = root.appending(path: name, directoryHint: .notDirectory).path(percentEncoded: false)
            // attributesOfItem doesn't follow a link: a link's own date counts.
            guard let created = try? fileManager.attributesOfItem(atPath: path)[.creationDate] as? Date, created < cutoff else { continue }
            do {
                try fileManager.removeItem(atPath: path)
                removed += 1
            } catch CocoaError.fileNoSuchFile {}
        }
        return removed
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

    /// Where a part file of this name lives (not checked or created).
    func partFileURL(named name: String) -> URL {
        root.appending(path: ".parts", directoryHint: .isDirectory).appending(path: name, directoryHint: .notDirectory)
    }

    /// Deletes every part file except the named ones (parts a background
    /// session is still sending). Call only at launch, before anything
    /// uploads. Removes a link in the folder's place without following it,
    /// and anything in the folder that isn't a plain file.
    public func clearPartFiles(keeping kept: Set<String> = []) throws {
        let folder = root.appending(path: ".parts", directoryHint: .isDirectory)
        let path = root.appending(path: ".parts", directoryHint: .notDirectory).path(percentEncoded: false)
        var status = stat()
        guard lstat(path, &status) == 0 else { return }
        guard status.st_mode & S_IFMT == S_IFDIR, !kept.isEmpty else {
            do {
                try FileManager.default.removeItem(atPath: path)
            } catch CocoaError.fileNoSuchFile {}
            return
        }
        for name in try FileManager.default.contentsOfDirectory(atPath: path) {
            let entry = folder.appending(path: name, directoryHint: .notDirectory).path(percentEncoded: false)
            var entryStatus = stat()
            guard lstat(entry, &entryStatus) == 0 else { continue }
            if kept.contains(name), entryStatus.st_mode & S_IFMT == S_IFREG { continue }
            // removeItem deletes a link itself, never its target.
            do {
                try FileManager.default.removeItem(atPath: entry)
            } catch CocoaError.fileNoSuchFile {}
        }
    }

    /// Symlinks resolved and `.`/`..` removed. Applied to both sides so
    /// system links (`/var` → `/private/var`) compare equal.
    private static func canonical(_ url: URL) -> URL {
        url.standardizedFileURL.resolvingSymlinksInPath()
    }
}
