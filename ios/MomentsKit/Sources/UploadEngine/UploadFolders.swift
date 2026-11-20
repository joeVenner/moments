import Foundation
import MomentsDomain

/// Where a queue keeps its records and staged files.
public struct UploadFolders: Sendable {
    public let store: QueueStore
    public let staging: StagingArea

    /// `<base>/UploadQueue` and `<base>/UploadStaging`, set up as the app's.
    public static func under(_ base: URL) throws -> UploadFolders {
        let store = QueueStore(directory: base.appending(path: "UploadQueue", directoryHint: .isDirectory))
        try store.prepareDirectory()
        let staging = try StagingArea.prepared(root: base.appending(path: "UploadStaging", directoryHint: .isDirectory))
        return UploadFolders(store: store, staging: staging)
    }

    /// The folders under `base` if it is a real folder (not a link), without
    /// creating or changing anything: for adopting what another queue left.
    public static func existing(at base: URL) -> UploadFolders? {
        var path = base.path(percentEncoded: false)
        if path.hasSuffix("/") { path.removeLast() }
        guard isFolder(path) else { return nil }
        // Either one may be missing (nothing queued yet), never a link: a
        // staging link could point the purge at another queue's files.
        for name in ["UploadQueue", "UploadStaging"] where !isFolder("\(path)/\(name)", orMissing: true) { return nil }
        return UploadFolders(
            store: QueueStore(directory: base.appending(path: "UploadQueue", directoryHint: .isDirectory)),
            staging: StagingArea(root: base.appending(path: "UploadStaging", directoryHint: .isDirectory))
        )
    }

    private static func isFolder(_ path: String, orMissing: Bool = false) -> Bool {
        var status = stat()
        guard lstat(path, &status) == 0 else { return orMissing && errno == ENOENT }
        return status.st_mode & S_IFMT == S_IFDIR
    }

    /// The App Clip's queue: `<group>/ClipUploads/…`, in the App Group so
    /// it outlives the Clip when the full app replaces it, and the app
    /// adopts it (`QueueAdoption`). Nil for an invalid group id or without
    /// the group's container (the entitlement is missing).
    public static func clip(appGroup: String?, fileManager: FileManager = .default) throws -> UploadFolders? {
        guard var base = clipBase(appGroup: appGroup, fileManager: fileManager) else { return nil }
        // The parent too (it holds nothing itself): the group isn't
        // excluded from backup, and createDirectory sets no attributes on an
        // existing folder. Best effort: the folders below carry both.
        try fileManager.createDirectory(at: base, withIntermediateDirectories: true, attributes: protection)
        try? fileManager.setAttributes(protection, ofItemAtPath: base.path(percentEncoded: false))
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? base.setResourceValues(values)
        return try under(base)
    }

    /// The same place, for the app to adopt from, without creating it.
    public static func clipBase(appGroup: String?, fileManager: FileManager = .default) -> URL? {
        guard let appGroup, AppGroupID.isValid(appGroup),
              let container = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
        else { return nil }
        return container.appending(path: "ClipUploads", directoryHint: .isDirectory)
    }

    private static var protection: [FileAttributeKey: Any] { [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication] }
}
