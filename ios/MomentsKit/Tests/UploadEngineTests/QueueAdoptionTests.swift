import Foundation
import Testing
@testable import UploadEngine

@Suite struct QueueAdoptionTests {
    private struct Side {
        let store: QueueStore
        let staging: StagingArea
        init(_ base: URL) throws {
            store = QueueStore(directory: base.appending(path: "UploadQueue", directoryHint: .isDirectory))
            staging = try StagingArea.prepared(root: base.appending(path: "UploadStaging", directoryHint: .isDirectory))
        }
    }

    private let base = FileManager.default.temporaryDirectory.appending(path: "adoption-\(UUID().uuidString)", directoryHint: .isDirectory)
    private var clip: URL { base.appending(path: "clip", directoryHint: .isDirectory) }
    private var app: URL { base.appending(path: "app", directoryHint: .isDirectory) }

    /// A queued item with its staged file, saved on `side`.
    private func queue(on side: Side, staged: Bool = true, bytes: Data = Data("photo".utf8), caption: String? = nil) throws -> QueuedUpload {
        let id = UUID()
        let item = QueuedUpload(
            id: id, eventSlug: "party",
            file: .init(relativePath: StagingArea.relativePath(for: id, name: "a.jpg"), size: Int64(bytes.count), contentType: "image/jpeg")!,
            caption: caption, createdAt: Date(timeIntervalSince1970: 1_000_000)
        )
        if staged {
            try FileManager.default.createDirectory(at: side.staging.folder(for: id), withIntermediateDirectories: true)
            try bytes.write(to: side.staging.folder(for: id).appending(path: "a.jpg"))
        }
        try side.store.save(item)
        return item
    }

    private func adopt(_ from: Side, _ into: Side) throws -> QueueAdoption.Report {
        try QueueAdoption.adopt(from: from.store, staging: from.staging, into: into.store, staging: into.staging)
    }

    private func exists(_ url: URL) -> Bool {
        var path = url.path(percentEncoded: false)
        if path.hasSuffix("/") { path.removeLast() }
        return (try? FileManager.default.attributesOfItem(atPath: path)) != nil
    }

    private func photo(_ side: Side, _ id: UUID) throws -> Data {
        try Data(contentsOf: side.staging.folder(for: id).appending(path: "a.jpg"))
    }

    @Test func movesRecordsAndTheirFiles() throws {
        defer { try? FileManager.default.removeItem(at: base) }
        let from = try Side(clip), into = try Side(app)
        let first = try queue(on: from), second = try queue(on: from)
        #expect(try adopt(from, into) == .init(adopted: 2))
        #expect(Set(try into.store.load().items.map(\.id)) == [first.id, second.id])
        #expect(try photo(into, first.id) == Data("photo".utf8))
        #expect(try from.store.recordIDs().isEmpty)
        #expect(!exists(from.staging.folder(for: first.id)))
        // Nothing left: a second run has nothing to do.
        #expect(try adopt(from, into) == .init())
        #expect(try into.store.recordIDs() == [first.id, second.id])
    }

    @Test func finishesAMoveStoppedAfterTheFiles() throws {
        defer { try? FileManager.default.removeItem(at: base) }
        let from = try Side(clip), into = try Side(app)
        let item = try queue(on: from)
        try FileManager.default.moveItem(at: from.staging.folder(for: item.id), to: into.staging.folder(for: item.id))
        #expect(try adopt(from, into) == .init(adopted: 1))
        #expect(try into.store.recordIDs() == [item.id])
        #expect(try photo(into, item.id) == Data("photo".utf8))
    }

    @Test func aCopyCutShortLosesToTheWholeSource() throws {
        defer { try? FileManager.default.removeItem(at: base) }
        let from = try Side(clip), into = try Side(app)
        let item = try queue(on: from, bytes: Data("whole".utf8))
        try FileManager.default.createDirectory(at: into.staging.folder(for: item.id), withIntermediateDirectories: true)
        try Data("wh".utf8).write(to: into.staging.folder(for: item.id).appending(path: "a.jpg"))
        #expect(try adopt(from, into) == .init(adopted: 1))
        #expect(try photo(into, item.id) == Data("whole".utf8))
    }

    @Test func anItemAlreadyMovedKeepsTheMovedCopy() throws {
        defer { try? FileManager.default.removeItem(at: base) }
        let from = try Side(clip), into = try Side(app)
        let item = try queue(on: from, caption: "old")
        // The earlier run moved everything, then stopped before cleaning up;
        // the app's copy has moved on since.
        try FileManager.default.copyItem(at: from.staging.folder(for: item.id), to: into.staging.folder(for: item.id))
        var moved = try #require(try from.store.load().items.first)
        moved.apply(.requestFailed(.rateLimited, clientUploadID: moved.clientUploadID), now: Date(timeIntervalSince1970: 1_000_100))
        try into.store.save(moved)
        #expect(try adopt(from, into) == .init(adopted: 1))
        #expect(try into.store.load().items == [moved])
        #expect(try from.store.recordIDs().isEmpty)
        #expect(!exists(from.staging.folder(for: item.id)))
    }

    @Test func aFailedRecordMovePutsTheFilesBack() throws {
        defer { try? FileManager.default.removeItem(at: base) }
        let from = try Side(clip), into = try Side(app)
        let item = try queue(on: from)
        try FileManager.default.createDirectory(at: into.store.directory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: into.store.directory.path(percentEncoded: false))
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: into.store.directory.path(percentEncoded: false)) }
        #expect(try adopt(from, into) == .init(skipped: 1))
        #expect(try photo(from, item.id) == Data("photo".utf8))
        #expect(try from.store.recordIDs() == [item.id])
        #expect(!exists(into.staging.folder(for: item.id)))
    }

    @Test func anItemItCantCheckStaysWhereItIs() throws {
        defer { try? FileManager.default.removeItem(at: base) }
        let from = try Side(clip), into = try Side(app)
        let item = try queue(on: from)
        // No search permission on the staging root: its folders can't be checked.
        let root = from.staging.root.path(percentEncoded: false)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: root)
        let report = try adopt(from, into)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root)
        #expect(report == .init(skipped: 1))
        #expect(try from.store.recordIDs() == [item.id])
        #expect(try photo(from, item.id) == Data("photo".utf8))
        #expect(try into.store.recordIDs().isEmpty)
    }

    @Test func movesARecordWithoutFiles() throws {
        defer { try? FileManager.default.removeItem(at: base) }
        let from = try Side(clip), into = try Side(app)
        let item = try queue(on: from, staged: false)
        #expect(try adopt(from, into) == .init(adopted: 1))
        #expect(try into.store.recordIDs() == [item.id])
    }

    @Test func deletesLinksWithoutTouchingWhatTheyPointAt() throws {
        defer { try? FileManager.default.removeItem(at: base) }
        let from = try Side(clip), into = try Side(app)
        let linkedRecord = try queue(on: from, staged: false)
        let real = base.appending(path: "elsewhere.json")
        try FileManager.default.moveItem(at: from.store.recordURL(for: linkedRecord.id), to: real)
        try FileManager.default.createSymbolicLink(at: from.store.recordURL(for: linkedRecord.id), withDestinationURL: real)

        let linkedFolder = try queue(on: from)
        let realFolder = base.appending(path: "elsewhere", directoryHint: .isDirectory)
        try FileManager.default.moveItem(at: from.staging.folder(for: linkedFolder.id), to: realFolder)
        try FileManager.default.createSymbolicLink(at: from.staging.folder(for: linkedFolder.id), withDestinationURL: realFolder)

        #expect(try adopt(from, into) == .init(discarded: 2))
        #expect(try into.store.recordIDs().isEmpty)
        #expect(!exists(into.staging.folder(for: linkedFolder.id)))
        #expect(try from.store.recordIDs().isEmpty)
        #expect(!exists(from.staging.folder(for: linkedFolder.id)))
        #expect(exists(real) && exists(realFolder.appending(path: "a.jpg")))
    }

    @Test func leavesNoPhotoBytesBehind() throws {
        defer { try? FileManager.default.removeItem(at: base) }
        let from = try Side(clip), into = try Side(app)
        // Staged without a record, a part file, a set-aside record.
        let orphan = from.staging.folder(for: UUID())
        try FileManager.default.createDirectory(at: orphan, withIntermediateDirectories: true)
        try Data("photo".utf8).write(to: orphan.appending(path: "a.jpg"))
        let part = try from.staging.partsFolder().appending(path: "part-1")
        try Data("photo".utf8).write(to: part)
        try FileManager.default.createDirectory(at: from.store.quarantine, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: from.store.quarantine.appending(path: "x.json"))

        #expect(try adopt(from, into) == .init())
        #expect(!exists(orphan))
        #expect(!exists(part))
        #expect(!exists(from.store.quarantine))
    }

    @Test func nothingToAdoptTouchesNothing() throws {
        defer { try? FileManager.default.removeItem(at: base) }
        let from = try Side(clip), into = try Side(app)
        #expect(try adopt(from, into) == .init())
        #expect(!exists(into.store.directory))
    }
}
