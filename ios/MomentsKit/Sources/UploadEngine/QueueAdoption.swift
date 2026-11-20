import Foundation

/// Moves another queue's unfinished uploads into this one: the App Clip's,
/// kept in the App Group so they outlive the Clip when the full app
/// replaces it (Apple: the app "can then access this local data").
///
/// Run it once per launch, before `UploadLaunch.prepare` (its sweep deletes
/// staged folders no record owns, and a moved folder keeps its old
/// creation date), and only where the other queue's owner can't be running
/// (the app: once it is installed, the Clip no longer launches).
///
/// Per item, the staged folder moves first, then the record; a failed
/// record move puts the folder back, and a crash in between is finished by
/// the next run. Only plain files and real folders move, never links: an
/// item with anything else is deleted. Moved items get this queue's file
/// protection. Afterwards nothing is left in the source but items that
/// failed to move (tried again next run): no photo bytes linger there.
public enum QueueAdoption {
    public struct Report: Equatable, Sendable {
        public var adopted = 0
        /// Left in place after a failed move: tried again next run.
        public var skipped = 0
        /// Deleted: a link or anything else that isn't a plain item.
        public var discarded = 0

        public init(adopted: Int = 0, skipped: Int = 0, discarded: Int = 0) {
            self.adopted = adopted
            self.skipped = skipped
            self.discarded = discarded
        }
    }

    /// `targetStaging` must exist (`StagingArea.prepared`). Throws only when
    /// the source folder can't be listed.
    public static func adopt(
        from source: QueueStore, staging sourceStaging: StagingArea,
        into target: QueueStore, staging targetStaging: StagingArea
    ) throws -> Report {
        let ids = try source.recordIDs()
        var report = Report()
        if !ids.isEmpty {
            // Before first unlock its attributes can't be set; the moves
            // below then fail and are tried again next run.
            try? target.prepareDirectory()
            for id in ids.sorted(by: { $0.uuidString < $1.uuidString }) {
                adopt(id, from: source, sourceStaging, into: target, targetStaging, &report)
            }
        }
        purge(source, sourceStaging)
        return report
    }

    private static func adopt(
        _ id: UUID, from source: QueueStore, _ sourceStaging: StagingArea,
        into target: QueueStore, _ targetStaging: StagingArea, _ report: inout Report
    ) {
        let fileManager = FileManager.default
        let record = source.recordURL(for: id)
        let folder = sourceStaging.folder(for: id)
        let targetRecord = target.recordURL(for: id)
        let targetFolder = targetStaging.folder(for: id)
        let recordEntry = entry(record), folderEntry = entry(folder), targetEntry = entry(targetRecord)
        // Can't tell now (before first unlock, say): never taken for junk.
        if recordEntry == .unreadable || folderEntry == .unreadable || targetEntry == .unreadable {
            report.skipped += 1
            return
        }
        // Gone since the listing: nothing to do.
        if recordEntry == .missing { return }
        let hasFolder = folderEntry == .folder
        guard recordEntry == .file, folderEntry != .other else {
            remove(record)
            if folderEntry != .missing { remove(folder) }
            report.discarded += 1
            return
        }
        // Already moved by an earlier run that stopped before cleaning up.
        if targetEntry == .file {
            if hasFolder { remove(folder) }
            remove(record)
            report.adopted += 1
            return
        }
        do {
            if hasFolder {
                // Both folders: an interrupted copy, which deletes its
                // source last, so the source is the whole one.
                if entry(targetFolder) != .missing { try fileManager.removeItem(atPath: path(targetFolder)) }
                try fileManager.moveItem(atPath: path(folder), toPath: path(targetFolder))
            }
            do {
                try fileManager.moveItem(atPath: path(record), toPath: path(targetRecord))
            } catch {
                // Back where its record is, so no sweep takes it for an orphan.
                if hasFolder { try? fileManager.moveItem(atPath: path(targetFolder), toPath: path(folder)) }
                throw error
            }
        } catch {
            report.skipped += 1
            return
        }
        protect(targetRecord)
        if hasFolder { protectTree(targetFolder) }
        report.adopted += 1
    }

    /// Clears what can never be adopted: staged folders without a record,
    /// part files and set-aside records.
    private static func purge(_ source: QueueStore, _ sourceStaging: StagingArea) {
        guard let owners = try? source.recordIDs() else { return }
        _ = try? sourceStaging.sweepItemFolders(keeping: owners, createdBefore: .distantFuture)
        try? sourceStaging.clearPartFiles()
        remove(source.quarantine)
    }

    private static func protect(_ url: URL) {
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path(url)
        )
    }

    /// The folder and the plain files in it, never through a link. Backup
    /// exclusion comes from the target root, which covers its whole tree.
    private static func protectTree(_ folder: URL) {
        protect(folder)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: path(folder))) ?? []
        for name in names {
            let file = folder.appending(path: name, directoryHint: .notDirectory)
            if entry(file) == .file { protect(file) }
        }
    }

    private static func remove(_ url: URL) {
        try? FileManager.default.removeItem(atPath: path(url))
    }

    private enum Entry: Equatable {
        case missing, file, folder
        /// A link, or anything else that isn't a plain file or folder.
        case other
        /// It may exist, but can't be checked now.
        case unreadable
    }

    /// Without following links.
    private static func entry(_ url: URL) -> Entry {
        var status = stat()
        guard lstat(path(url), &status) == 0 else { return errno == ENOENT ? .missing : .unreadable }
        switch status.st_mode & S_IFMT {
        case S_IFREG: return .file
        case S_IFDIR: return .folder
        default: return .other
        }
    }

    /// No trailing "/": with one, a link to a folder would be followed.
    private static func path(_ url: URL) -> String {
        var path = url.path(percentEncoded: false)
        while path.count > 1, path.hasSuffix("/") { path.removeLast() }
        return path
    }
}
