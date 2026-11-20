import Foundation

/// Saves queued uploads, one JSON file per item named by its id, so a
/// damaged or tampered record costs that item and never the whole queue.
///
/// The app's lives in its own Application Support folder. The App Clip's
/// lives in the App Group (`UploadFolders.clip`) so the app can adopt it;
/// that's safe because nothing here holds a file lock (records are written
/// atomically, staged files only read), and a suspended app is killed
/// (0xdead10cc) only for a lock held in a shared container. Files are excluded from backup (they point at staged
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
    /// plain file or hard-linked, undecodable, misnamed) move to the quarantine folder, or
    /// are deleted when it is full, so they don't fail every launch. Ones
    /// that merely can't be read now stay in place: a read error is never
    /// taken for corruption, or a wake before first unlock would wipe the
    /// queue. Throws when the folder itself can't be listed.
    public func load() throws -> Loaded {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: directory.path(percentEncoded: false)) else { return Loaded(items: []) }
        // Best effort: failing to refresh the folder's attributes (it may be
        // locked) must not hold back the whole queue.
        try? prepareDirectory()
        let urls = try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
        sweepLeftovers(urls)
        var quarantined = 0, deferred = 0
        // Misnamed records are set aside without reading, so junk can't
        // take the slots of real records under the cap.
        var records: [URL] = []
        for url in urls where url.pathExtension == "json" {
            if Self.isCanonicalRecordName(url.lastPathComponent) {
                records.append(url)
            } else {
                setAside(url)
                quarantined += 1
            }
        }
        // Capped before reading, so a flood of records costs at most
        // `maxItems` reads. Sorted by name for a stable choice (file dates
        // change on every atomic save).
        records.sort { $0.lastPathComponent < $1.lastPathComponent }
        var found: [(item: QueuedUpload, url: URL)] = []
        for url in records.prefix(maxItems) {
            switch read(url) {
            case let .item(item): found.append((item, url))
            case .unusable:
                setAside(url)
                quarantined += 1
            case .notNow: deferred += 1
            case .gone: break
            }
        }
        found.sort { ($0.item.createdAt, $0.item.id.uuidString) < ($1.item.createdAt, $1.item.id.uuidString) }
        // Each staged file belongs to one item; a later record naming the
        // same file (tampering or a bug) would upload it twice or elsewhere.
        // It is left in place rather than deleted (it may be the valid one
        // if an older record is only deferred), but not loaded. The key is
        // normalized because APFS ignores case and Unicode form.
        var items: [QueuedUpload] = []
        var paths: Set<String> = []
        for (item, _) in found {
            if paths.insert(item.file.relativePath.precomposedStringWithCanonicalMapping.lowercased()).inserted {
                items.append(item)
            } else {
                deferred += 1
            }
        }
        return Loaded(items: items, quarantined: quarantined, deferred: deferred, overflow: max(records.count - maxItems, 0))
    }

    /// The ids of every record on disk, loaded or not (deferred, overflow):
    /// whatever owns a staged folder. Read from file names only, so it works
    /// while the phone is locked. Empty when the folder doesn't exist.
    public func recordIDs() throws -> Set<UUID> {
        guard FileManager.default.fileExists(atPath: directory.path(percentEncoded: false)) else { return [] }
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path(percentEncoded: false))
        return Set(names.compactMap { name in
            Self.isCanonicalRecordName(name) ? UUID(uuidString: String(name.dropLast(5))) : nil
        })
    }

    /// Deletes the records of `eventSlug` not in `excluding` (the loaded
    /// ones, which the queue removes itself): records deferred or over the
    /// cap at launch. Returns them, for their staged files. A record that
    /// can't be read now is left; it can't upload without the guest's token.
    public func removeRecords(eventSlug: String, excluding loaded: Set<UUID>) throws -> [QueuedUpload] {
        var removed: [QueuedUpload] = []
        for id in try recordIDs().subtracting(loaded) {
            guard case let .item(item) = read(recordURL(for: id)), item.eventSlug == eventSlug else { continue }
            try remove(id: id)
            removed.append(item)
        }
        return removed
    }

    /// `<UPPERCASE-UUID>.json`, as `save` writes it.
    static func isCanonicalRecordName(_ name: String) -> Bool {
        guard name.hasSuffix(".json"), let id = UUID(uuidString: String(name.dropLast(5))) else { return false }
        return name == "\(id.uuidString).json"
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
        /// Vanished since the listing.
        case gone
    }

    /// The record, if it is a plain, small file holding a valid item whose
    /// id matches its canonical name (so one record can't shadow another).
    /// Read through one descriptor opened without following links and
    /// checked with `fstat`, so a file swapped after listing can't make it
    /// read something else or something huge.
    private func read(_ url: URL) -> ReadResult {
        guard let id = UUID(uuidString: url.deletingPathExtension().lastPathComponent) else { return .unusable }
        let data: Data
        switch FileReader.read(url, maxBytes: Self.maxRecordBytes) {
        case let .data(read): data = read
        case .unusable: return .unusable
        case .notNow: return .notNow
        case .gone: return .gone
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
    func prepareDirectory() throws {
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
