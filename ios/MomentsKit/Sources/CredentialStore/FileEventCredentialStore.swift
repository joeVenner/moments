import Foundation
import MomentsDomain

/// File-backed store for the App Clip handover: one JSON file in the App
/// Group container that the Clip and the app share. An App Clip can't hold
/// keychain access groups, and its own keychain items go when the app
/// replaces it, so the container is how a guest moves to the app.
///
/// - Complete file protection: unreadable while the phone is locked (the
///   Clip writes and the app imports in the foreground).
/// - Excluded from backups, so a token can't be restored to another device
///   (what `ThisDeviceOnly` does for the keychain).
/// - Each entry is decoded on its own: one this version can't read reads as
///   nil and is never deleted by a partial change, as in the keychain store.
///   A file this version can't read at all is never written over (see
///   `StoreError`).
/// - All operations go through one lock, so `update` is atomic in-process.
///   There is no cross-process lock: the Clip and the app never run at the
///   same time (installing the app replaces the Clip).
public final class FileEventCredentialStore: EventCredentialStore, @unchecked Sendable {
    // @unchecked: an immutable URL plus `lock`, which guards every file access.
    public enum StoreError: Error, Equatable {
        /// A change would have replaced an entry this version can't read.
        case unreadableItem
        /// A newer build wrote the file in a format this one can't read:
        /// nothing is read from it or written over it until it is older than
        /// `CredentialHandoff.handoffWindow`, when it is deleted.
        case newerFormat
        /// The file can't be decoded (damaged): reads see nothing, and no
        /// write replaces it (other guests' entries may be in it) until it is
        /// older than `CredentialHandoff.handoffWindow`, when it is deleted.
        case unreadableFile
    }

    private let fileURL: URL
    private let now: @Sendable () -> Date
    private let lock = NSLock()

    public init(directory: URL, now: @escaping @Sendable () -> Date = { Date() }) {
        fileURL = directory.appending(path: "event-credentials.json")
        self.now = now
    }

    /// The handover store in the App Group container; nil without a group
    /// name the build filled in ("group.…") or when this build isn't
    /// entitled to it.
    public static func handover(appGroup: String?) -> FileEventCredentialStore? {
        guard let appGroup, appGroup.wholeMatch(of: /group\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/) != nil,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
        else { return nil }
        return FileEventCredentialStore(directory: container.appending(path: "Handover", directoryHint: .isDirectory))
    }

    public func credentials(for slug: EventSlug) throws -> StoredEventCredentials? {
        try lock.withLock { try load(forWriting: false)[slug.value].flatMap(StoredEventCredentials.decode) }
    }

    public func save(_ credentials: StoredEventCredentials, for slug: EventSlug) throws {
        try lock.withLock {
            var entries = try load(forWriting: true)
            entries[slug.value] = credentials.isEmpty ? nil : try StoredEventCredentials.encode(credentials)
            try store(entries)
        }
    }

    public func update(for slug: EventSlug, _ change: (inout StoredEventCredentials) -> Void) throws {
        try lock.withLock {
            var entries = try load(forWriting: true)
            let data = entries[slug.value]
            let decoded = data.flatMap(StoredEventCredentials.decode)
            let original = decoded ?? StoredEventCredentials()
            var value = original
            change(&value)
            guard value != original else { return }
            if data != nil && decoded == nil && value.isEmpty { throw StoreError.unreadableItem }
            entries[slug.value] = value.isEmpty ? nil : try StoredEventCredentials.encode(value)
            try store(entries)
        }
    }

    public func removeCredentials(for slug: EventSlug) throws {
        try lock.withLock {
            var entries = try load(forWriting: true)
            guard entries.removeValue(forKey: slug.value) != nil else { return }
            try store(entries)
        }
    }

    /// Deletes the file without reading it, whatever it holds.
    public func removeAll() throws {
        try lock.withLock { try store([:]) }
    }

    public func storedSlugs() throws -> [EventSlug] {
        try lock.withLock { try load(forWriting: false).keys.compactMap(EventSlug.init).sorted { $0.value < $1.value } }
    }

    // MARK: - Unlocked helpers (callers hold `lock`)

    /// Bumped when the file's shape changes incompatibly.
    static let fileVersion = 1

    private struct Contents: Codable {
        var version = FileEventCredentialStore.fileVersion
        var entries: [String: Data]
    }

    private struct Header: Decodable {
        var version: Int?
    }

    /// Missing file: nothing stored. A file that can't be opened (a locked
    /// phone) or that a newer build wrote throws. A damaged one reads as
    /// empty and refuses writes (`unreadableFile`). Either is deleted once
    /// older than the handover window, so it can't block the Clip for good.
    private func load(forWriting: Bool) throws -> [String: Data] {
        let data: Data
        do {
            data = try Data(contentsOf: fileURL)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return [:]
        }
        let decoder = JSONDecoder()
        let isNewer = ((try? decoder.decode(Header.self, from: data))?.version ?? 0) > Self.fileVersion
        let contents = isNewer ? nil : try? decoder.decode(Contents.self, from: data)
        if let contents { return contents.entries }
        // Not readable by this version: kept for the handover window, then gone.
        let modified = try FileManager.default.attributesOfItem(atPath: fileURL.path)[.modificationDate] as? Date
        if let modified, now().timeIntervalSince(modified) > CredentialHandoff.handoffWindow {
            try store([:])
            return [:]
        }
        if isNewer { throw StoreError.newerFormat }
        if forWriting { throw StoreError.unreadableFile }
        return [:]
    }

    private func store(_ entries: [String: Data]) throws {
        let files = FileManager.default
        guard !entries.isEmpty else {
            do {
                try files.removeItem(at: fileURL)
            } catch let error as CocoaError where error.code == .fileNoSuchFile {}
            return
        }
        // Excluding the folder excludes everything in it, the file an atomic
        // write puts in place included.
        var directory = fileURL.deletingLastPathComponent()
        try files.createDirectory(at: directory, withIntermediateDirectories: true)
        var noBackup = URLResourceValues()
        noBackup.isExcludedFromBackup = true
        try directory.setResourceValues(noBackup)
        try JSONEncoder().encode(Contents(entries: entries)).write(to: fileURL, options: [.atomic, .completeFileProtection])
    }
}
