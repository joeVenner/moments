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
    /// The default cap on queued items.
    public static let defaultMaxItems = 1000
    /// Invalid records kept for diagnosis; beyond this they are deleted.
    public static let maxQuarantined = 20

    /// What `load()` found.
    public struct Loaded: Sendable, Equatable {
        /// Valid items, oldest first.
        public let items: [QueuedUpload]
        /// Records that couldn't be used and were set aside.
        public let quarantined: Int
        /// Records left in place for a later launch: unreadable right now
        /// (before first unlock after a reboot) or written by a newer app.
        public let deferred: Int
        /// Records beyond `maxItems`, left on disk and not loaded. The
        /// engine refuses new items while the queue is full.
        public let overflow: Int

        public init(items: [QueuedUpload], quarantined: Int = 0, deferred: Int = 0, overflow: Int = 0) {
            self.items = items
            self.quarantined = quarantined
            self.deferred = deferred
            self.overflow = overflow
        }
    }

    public let directory: URL
    /// At most this many records are read per load, oldest files first.
    public let maxItems: Int
    var quarantine: URL { directory.appending(path: "quarantine", directoryHint: .isDirectory) }

    public init(directory: URL, maxItems: Int = QueueStore.defaultMaxItems) {
        self.directory = directory
        self.maxItems = maxItems
    }

    /// `Application Support/UploadQueue` in the app's own container.
    public static func appDefault(fileManager: FileManager = .default) throws -> QueueStore {
        let support = try fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return QueueStore(directory: support.appending(path: "UploadQueue", directoryHint: .isDirectory))
    }

    /// Writes the item atomically, replacing its previous record.
    public func save(_ item: QueuedUpload) throws {
        if !FileManager.default.fileExists(atPath: directory.path(percentEncoded: false)) { try prepareDirectory() }
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

    /// Reads the records. Ones that can never be used (oversized, not a
    /// plain file, undecodable, misnamed) move to the quarantine folder, or
    /// are deleted when it is full, so they don't fail every launch. Ones
    /// that merely can't be read now stay in place: a read error is never
    /// taken for corruption, or a wake before first unlock would wipe the
    /// queue. Throws when the folder itself can't be listed.
    public func load() throws -> Loaded {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: directory.path(percentEncoded: false)) else { return Loaded(items: []) }
        try prepareDirectory()
        let keys: [URLResourceKey] = [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .creationDateKey]
        let urls = try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])
        sweepLeftovers(urls)
        // Capped before reading, oldest files first, so a flood of records
        // costs at most `maxItems` reads.
        let records = urls.filter { $0.pathExtension == "json" }
            .map { (url: $0, created: (try? $0.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast) }
            .sorted { ($0.created, $0.url.lastPathComponent) < ($1.created, $1.url.lastPathComponent) }
        var found: [(item: QueuedUpload, url: URL)] = []
        var quarantined = 0, deferred = 0
        for record in records.prefix(maxItems) {
            switch read(record.url) {
            case let .item(item): found.append((item, record.url))
            case .unusable:
                setAside(record.url)
                quarantined += 1
            case .notNow: deferred += 1
            }
        }
        found.sort { ($0.item.createdAt, $0.item.id.uuidString) < ($1.item.createdAt, $1.item.id.uuidString) }
        // Each staged file belongs to one item; a later record naming the
        // same file (tampering or a bug) would upload it twice or elsewhere.
        var items: [QueuedUpload] = []
        var paths: Set<String> = []
        for (item, url) in found {
            if paths.insert(item.file.relativePath).inserted {
                items.append(item)
            } else {
                setAside(url)
                quarantined += 1
            }
        }
        return Loaded(items: items, quarantined: quarantined, deferred: deferred, overflow: max(records.count - maxItems, 0))
    }

    func recordURL(for id: UUID) -> URL {
        directory.appending(path: "\(id.uuidString).json", directoryHint: .notDirectory)
    }

    private enum ReadResult {
        case item(QueuedUpload)
        /// Can never be used: set it aside.
        case unusable
        /// Can't be read now, or needs a newer app: leave it.
        case notNow
    }

    /// The record, if it is a plain, small file holding a valid item whose
    /// id matches its canonical name (so one record can't shadow another).
    /// Read through one descriptor opened without following links and
    /// checked with `fstat`, so a file swapped after listing can't make it
    /// read something else or something huge.
    private func read(_ url: URL) -> ReadResult {
        guard let id = UUID(uuidString: url.deletingPathExtension().lastPathComponent),
              url.lastPathComponent == recordURL(for: id).lastPathComponent
        else { return .unusable }
        let data: Data
        switch FileReader.read(url, maxBytes: Self.maxRecordBytes) {
        case let .data(read): data = read
        case .unusable: return .unusable
        case .notNow: return .notNow
        }
        guard let version = try? JSONDecoder().decode(Version.self, from: data) else { return .unusable }
        if let found = version.schemaVersion, found > QueuedUpload.schemaVersion { return .notNow }
        guard let item = try? JSONDecoder().decode(QueuedUpload.self, from: data), item.id == id else { return .unusable }
        return .item(item)
    }

    /// Just the version, to tell "written by a newer app" from "corrupt".
    private struct Version: Decodable {
        let schemaVersion: Int?
    }

    /// Temporary files an interrupted atomic write left behind
    /// (`<id>.json.<suffix>`); nothing writes while the queue loads.
    private func sweepLeftovers(_ urls: [URL]) {
        for url in urls {
            let name = url.lastPathComponent
            guard let dot = name.range(of: ".json."), UUID(uuidString: String(name[..<dot.lowerBound])) != nil,
                  (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
            else { continue }
            try? FileManager.default.removeItem(at: url)
        }
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

    /// Creates the folder if needed and (re)applies its protection class
    /// and backup exclusion, which `createDirectory` skips for an existing
    /// folder.
    private func prepareDirectory() throws {
        try createDirectory(directory)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: directory.path(percentEncoded: false)
        )
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
