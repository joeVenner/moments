import Foundation

/// Saves queued uploads, one JSON file per item named by its id, so a
/// damaged or tampered record costs that item and never the whole queue.
///
/// Lives in the app's own Application Support folder, not the App Group: a
/// suspended app holding a file lock in a shared container is killed by the
/// system (0xdead10cc). Files are excluded from backup (they point at staged
/// files that aren't backed up either) and readable after first unlock, so a
/// background wake while the phone is locked can still update them.
///
/// Not thread-safe on its own; the upload engine actor owns it.
public struct QueueStore: Sendable {
    /// Records larger than this are not read (a valid one is ~1 KB).
    public static let maxRecordBytes = 64 * 1024
    /// At most this many items are loaded, oldest first.
    public static let maxItems = 1000
    /// Invalid records kept for diagnosis; beyond this they are deleted.
    public static let maxQuarantined = 20

    /// What `load()` found.
    public struct Loaded: Sendable, Equatable {
        /// Valid items, oldest first.
        public let items: [QueuedUpload]
        /// Records that couldn't be used and were set aside.
        public let quarantined: Int
    }

    public let directory: URL
    var quarantine: URL { directory.appending(path: "quarantine", directoryHint: .isDirectory) }

    public init(directory: URL) {
        self.directory = directory
    }

    /// `Application Support/UploadQueue` in the app's own container.
    public static func appDefault(fileManager: FileManager = .default) throws -> QueueStore {
        let support = try fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return QueueStore(directory: support.appending(path: "UploadQueue", directoryHint: .isDirectory))
    }

    /// Writes the item atomically, replacing its previous record.
    public func save(_ item: QueuedUpload) throws {
        try prepareDirectory()
        let data = try JSONEncoder().encode(item)
        try data.write(to: recordURL(for: item.id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// Deletes the item's record; a missing one is fine.
    public func remove(id: UUID) throws {
        do {
            try FileManager.default.removeItem(at: recordURL(for: id))
        } catch CocoaError.fileNoSuchFile {
            return
        }
    }

    /// Reads every record. Unreadable, oversized, undecodable or misnamed
    /// ones are moved to the quarantine folder (or deleted when it is full)
    /// so they don't fail every later launch.
    public func load() throws -> Loaded {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: directory.path(percentEncoded: false)) else {
            return Loaded(items: [], quarantined: 0)
        }
        let urls = try fileManager.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey], options: [.skipsHiddenFiles]
        )
        var items: [QueuedUpload] = []
        var quarantined = 0
        for url in urls where url.pathExtension == "json" {
            if let item = read(url) {
                items.append(item)
            } else {
                setAside(url)
                quarantined += 1
            }
        }
        items.sort { ($0.createdAt, $0.id.uuidString) < ($1.createdAt, $1.id.uuidString) }
        return Loaded(items: Array(items.prefix(Self.maxItems)), quarantined: quarantined)
    }

    func recordURL(for id: UUID) -> URL {
        directory.appending(path: "\(id.uuidString).json", directoryHint: .notDirectory)
    }

    /// The record, if it is a plain, small file holding a valid item whose
    /// id matches its name (so one record can't shadow another).
    private func read(_ url: URL) -> QueuedUpload? {
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size <= Self.maxRecordBytes,
              let id = UUID(uuidString: url.deletingPathExtension().lastPathComponent),
              let data = try? Data(contentsOf: url),
              let item = try? JSONDecoder().decode(QueuedUpload.self, from: data),
              item.id == id
        else { return nil }
        return item
    }

    private func setAside(_ url: URL) {
        let fileManager = FileManager.default
        let kept = (try? fileManager.contentsOfDirectory(atPath: quarantine.path(percentEncoded: false)).count) ?? 0
        if kept < Self.maxQuarantined, (try? createDirectory(quarantine)) != nil {
            let target = quarantine.appending(path: "\(UUID().uuidString).json", directoryHint: .notDirectory)
            if (try? fileManager.moveItem(at: url, to: target)) != nil { return }
        }
        try? fileManager.removeItem(at: url)
    }

    private func prepareDirectory() throws {
        try createDirectory(directory)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = directory
        try url.setResourceValues(values)
    }

    private func createDirectory(_ url: URL) throws {
        try FileManager.default.createDirectory(
            at: url, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
    }
}
