import Foundation
import MomentsAPI
import Testing
@testable import UploadEngine

/// A fresh temporary folder, removed when the test ends.
final class TempFolder {
    let url = FileManager.default.temporaryDirectory.appending(path: "QueueStoreTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    init() throws { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }
    deinit { try? FileManager.default.removeItem(at: url) }
}

private func item(_ name: String = "a.jpg", at seconds: TimeInterval = 0) -> QueuedUpload {
    QueuedUpload(
        eventSlug: "party", file: .init(relativePath: name, size: 10, contentType: "image/jpeg")!,
        caption: nil, createdAt: Date(timeIntervalSince1970: 1_000_000 + seconds)
    )
}

@Suite struct QueueStoreTests {
    @Test func savesAndLoadsItemsOldestFirst() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url.appending(path: "queue"))
        #expect(try store.load() == .init(items: [], quarantined: 0))

        let newer = item("n.jpg", at: 10), older = item("o.jpg", at: 0)
        try store.save(newer)
        try store.save(older)
        #expect(try store.load() == .init(items: [older, newer], quarantined: 0))
    }

    @Test func replacesAnItemsRecordOnSave() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url)
        var upload = item()
        try store.save(upload)
        upload.apply(.requestFailed(.storageUnavailable, clientUploadID: upload.clientUploadID), now: Date())
        try store.save(upload)
        #expect(try store.load().items == [upload])
    }

    @Test func removesItemsAndToleratesMissingOnes() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url)
        let upload = item()
        try store.save(upload)
        try store.remove(id: upload.id)
        try store.remove(id: upload.id)
        #expect(try store.load().items.isEmpty)
    }

    @Test func excludesTheQueueFromBackup() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url.appending(path: "queue"))
        try store.save(item())
        #expect(try store.directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    }

    @Test func setsBadRecordsAsideAndKeepsTheRest() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url)
        let good = item()
        try store.save(good)

        // Garbage, a record under another item's name, an oversized file and
        // a non-UUID name.
        try Data("not json".utf8).write(to: store.recordURL(for: UUID()))
        try JSONEncoder().encode(item("b.jpg")).write(to: store.recordURL(for: UUID()))
        try Data(count: QueueStore.maxRecordBytes + 1).write(to: store.recordURL(for: UUID()))
        try JSONEncoder().encode(item("c.jpg")).write(to: folder.url.appending(path: "x.json"))
        // Not a record: left alone.
        try Data("note".utf8).write(to: folder.url.appending(path: "readme.txt"))

        let loaded = try store.load()
        #expect(loaded == .init(items: [good], quarantined: 4))
        #expect(try FileManager.default.contentsOfDirectory(atPath: store.quarantine.path()).count == 4)
        // Set aside for good: the next launch is clean.
        #expect(try store.load() == .init(items: [good], quarantined: 0))
        #expect(FileManager.default.fileExists(atPath: folder.url.appending(path: "readme.txt").path()))
    }

    @Test func refusesASymlinkedRecord() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url.appending(path: "queue"))
        let upload = item()
        try store.save(upload)
        let outside = folder.url.appending(path: "elsewhere.json")
        try FileManager.default.moveItem(at: store.recordURL(for: upload.id), to: outside)
        try FileManager.default.createSymbolicLink(at: store.recordURL(for: upload.id), withDestinationURL: outside)
        #expect(try store.load() == .init(items: [], quarantined: 1))
        #expect(FileManager.default.fileExists(atPath: outside.path()))
    }

    @Test func leavesUnreadableAndNewerRecordsInPlace() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url)
        let locked = item("a.jpg"), newer = item("b.jpg")
        try store.save(locked)
        // Unreadable right now, like a record before first unlock.
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: store.recordURL(for: locked.id).path())
        let json = String(decoding: try JSONEncoder().encode(newer), as: UTF8.self)
        #expect(json.contains("\"schemaVersion\":1"))
        try Data(json.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":2").utf8)
            .write(to: store.recordURL(for: newer.id))

        #expect(try store.load() == .init(items: [], deferred: 2))
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: store.recordURL(for: locked.id).path())
        #expect(try store.load() == .init(items: [locked], deferred: 1))
    }

    @Test func readsAtMostMaxItemsAndReportsTheRest() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url, maxItems: 2)
        for index in 0 ..< 3 { try store.save(item("\(index).jpg", at: Double(index))) }
        let loaded = try store.load()
        #expect(loaded.items.count == 2 && loaded.overflow == 1 && loaded.quarantined == 0)
    }

    @Test func ordersItemsCreatedAtTheSameTimeByID() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url)
        let items = (0 ..< 4).map { item("\($0).jpg") }
        for upload in items { try store.save(upload) }
        #expect(try store.load().items == items.sorted { $0.id.uuidString < $1.id.uuidString })
    }

    @Test func keepsTheBackupExclusionAcrossSaves() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url.appending(path: "queue"))
        var upload = item()
        try store.save(upload)
        upload.apply(.requestFailed(.storageUnavailable, clientUploadID: upload.clientUploadID), now: Date())
        try store.save(upload)
        _ = try store.load()
        #expect(try store.directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    }

    @Test func refusesNonCanonicalNamesAndSharedStagedFiles() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url)
        let first = item("ev/a.jpg", at: 0), second = item("ev/a.jpg", at: 5), variant = item("EV/A.jpg", at: 6)
        let lower = item("b.jpg")
        for upload in [first, second, variant] { try store.save(upload) }
        try JSONEncoder().encode(lower).write(to: folder.url.appending(path: "\(lower.id.uuidString.lowercased()).json"))
        // Duplicates stay on disk (deferred), the misnamed record is set aside.
        #expect(try store.load() == .init(items: [first], quarantined: 1, deferred: 2))
        #expect(FileManager.default.fileExists(atPath: store.recordURL(for: second.id).path()))
    }

    @Test func refusesAHardLinkedRecord() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url.appending(path: "queue"))
        let upload = item()
        try store.save(upload)
        try FileManager.default.linkItem(at: store.recordURL(for: upload.id), to: folder.url.appending(path: "other"))
        #expect(try store.load() == .init(items: [], quarantined: 1))
    }

    @Test func junkDoesNotTakeTheSlotsOfRealRecords() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url, maxItems: 1)
        let upload = item()
        try store.save(upload)
        for index in 0 ..< 3 { try Data("x".utf8).write(to: folder.url.appending(path: "junk\(index).json")) }
        #expect(try store.load() == .init(items: [upload], quarantined: 3))
    }

    @Test func reappliesTheBackupExclusionOnLoad() throws {
        let folder = try TempFolder()
        var directory = folder.url.appending(path: "queue")
        let store = QueueStore(directory: directory)
        try store.save(item())
        var values = URLResourceValues()
        values.isExcludedFromBackup = false
        try directory.setResourceValues(values)
        _ = try store.load()
        directory.removeAllCachedResourceValues()
        #expect(try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    }

    @Test func sweepsLeftoversFromInterruptedWrites() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url)
        try store.save(item())
        let leftover = folder.url.appending(path: "\(UUID().uuidString).json.sb-1234")
        try Data("partial".utf8).write(to: leftover)
        let keep = ["notes.json.bak", "\(UUID().uuidString)"]
        for name in keep { try Data("x".utf8).write(to: folder.url.appending(path: name)) }
        let folderLike = folder.url.appending(path: "\(UUID().uuidString).json.dir")
        try FileManager.default.createDirectory(at: folderLike, withIntermediateDirectories: true)
        _ = try store.load()
        #expect(!FileManager.default.fileExists(atPath: leftover.path()))
        for name in keep { #expect(FileManager.default.fileExists(atPath: folder.url.appending(path: name).path())) }
        #expect(FileManager.default.fileExists(atPath: folderLike.path()))
    }

    @Test func deletesBadRecordsOnceTheQuarantineIsFull() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url)
        for _ in 0 ..< QueueStore.maxQuarantined + 3 {
            try Data("x".utf8).write(to: store.recordURL(for: UUID()))
        }
        #expect(try store.load().quarantined == QueueStore.maxQuarantined + 3)
        #expect(try FileManager.default.contentsOfDirectory(atPath: store.quarantine.path()).count == QueueStore.maxQuarantined)
        #expect(try store.load().quarantined == 0)
    }
}

@Suite struct StagingAreaTests {
    private let owner = UUID()

    private func staged(_ name: String, size: Int64 = 4, owner: UUID? = nil) -> QueuedUpload.StagedFile {
        .init(relativePath: StagingArea.relativePath(for: owner ?? self.owner, name: name), size: size, contentType: "image/jpeg")!
    }

    /// A staging area with the owner's folder created.
    private func area(_ folder: TempFolder) throws -> StagingArea {
        let area = StagingArea(root: folder.url.appending(path: "staging"))
        try FileManager.default.createDirectory(at: area.folder(for: owner), withIntermediateDirectories: true)
        return area
    }

    private func write(_ area: StagingArea, _ name: String, owner: UUID? = nil) throws -> URL {
        let url = area.folder(for: owner ?? self.owner).appending(path: name)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("abcd".utf8).write(to: url)
        return url
    }

    @Test func opensAndRemovesAFileInItsOwnersFolder() throws {
        let folder = try TempFolder()
        let area = try area(folder)
        let url = try write(area, "sub/a.jpg")
        #expect(try area.open(staged("sub/a.jpg"), owner: owner).readToEnd() == Data("abcd".utf8))
        try area.remove(staged("sub/a.jpg"), owner: owner)
        #expect(!FileManager.default.fileExists(atPath: url.path()))
        try area.remove(staged("sub/a.jpg"), owner: owner) // already gone: fine
    }

    @Test func refusesAnotherItemsFile() throws {
        let folder = try TempFolder()
        let area = try area(folder)
        let other = UUID()
        let url = try write(area, "a.jpg", owner: other)
        #expect(throws: StagingArea.Problem.outsideStaging) { try area.open(staged("a.jpg", owner: other), owner: owner) }
        #expect(throws: StagingArea.Problem.outsideStaging) { try area.remove(staged("a.jpg", owner: other), owner: owner) }
        #expect(FileManager.default.fileExists(atPath: url.path()))
    }

    @Test func refusesMissingChangedAndNonFiles() throws {
        let folder = try TempFolder()
        let area = try area(folder)
        _ = try write(area, "a.jpg")
        try FileManager.default.createDirectory(at: area.folder(for: owner).appending(path: "dir"), withIntermediateDirectories: true)
        #expect(throws: StagingArea.Problem.missing) { try area.open(staged("b.jpg"), owner: owner) }
        #expect(throws: StagingArea.Problem.sizeChanged) { try area.open(staged("a.jpg", size: 5), owner: owner) }
        #expect(throws: StagingArea.Problem.notAFile) { try area.open(staged("dir"), owner: owner) }
    }

    @Test func refusesHardLinksFifosAndUnreadableFiles() throws {
        let folder = try TempFolder()
        let area = try area(folder)
        let file = try write(area, "a.jpg")
        try FileManager.default.linkItem(at: file, to: area.folder(for: owner).appending(path: "b.jpg"))
        #expect(throws: StagingArea.Problem.notAFile) { try area.open(staged("b.jpg"), owner: owner) }

        #expect(mkfifo(area.folder(for: owner).appending(path: "f.jpg").path(), 0o600) == 0)
        #expect(throws: StagingArea.Problem.notAFile) { try area.open(staged("f.jpg"), owner: owner) }

        let locked = try write(area, "c.jpg")
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: locked.path())
        #expect(throws: StagingArea.Problem.unreadable) { try area.open(staged("c.jpg"), owner: owner) }
    }

    @Test func refusesLinksEvenInsideTheFolder() throws {
        let folder = try TempFolder()
        let area = try area(folder)
        let other = UUID()
        let target = try write(area, "a.jpg", owner: other)
        // A file link to another item's file, and a folder link to another
        // item's folder.
        try FileManager.default.createSymbolicLink(at: area.folder(for: owner).appending(path: "a.jpg"), withDestinationURL: target)
        try FileManager.default.createSymbolicLink(
            at: area.folder(for: owner).appending(path: "up"), withDestinationURL: area.folder(for: other)
        )
        #expect(throws: StagingArea.Problem.notAFile) { try area.open(staged("a.jpg"), owner: owner) }
        #expect(throws: StagingArea.Problem.outsideStaging) { try area.open(staged("up/a.jpg"), owner: owner) }
        #expect(throws: StagingArea.Problem.outsideStaging) { try area.remove(staged("up/a.jpg"), owner: owner) }
        // Removing the link deletes the link, not the other item's file.
        try area.remove(staged("a.jpg"), owner: owner)
        #expect(FileManager.default.fileExists(atPath: target.path()))
    }

    @Test func refusesAnOwnerFolderThatIsALink() throws {
        let folder = try TempFolder()
        let area = StagingArea(root: folder.url.appending(path: "staging"))
        let other = UUID()
        _ = try write(area, "a.jpg", owner: other)
        try FileManager.default.createSymbolicLink(at: area.folder(for: owner), withDestinationURL: area.folder(for: other))
        #expect(throws: StagingArea.Problem.outsideStaging) { try area.open(staged("a.jpg"), owner: owner) }
    }

    @Test func handlesOddPathsAndAMissingOwnerFolder() throws {
        let folder = try TempFolder()
        let area = StagingArea(root: folder.url.appending(path: "staging/"))
        let other = UUID()
        let escape = QueuedUpload.StagedFile(relativePath: "\(owner.uuidString)/../\(other.uuidString)/a.jpg", size: 4, contentType: "image/jpeg")
        // Refused when decoded or created, so it never reaches the area.
        #expect(escape == nil)
        #expect(throws: StagingArea.Problem.missing) { try area.open(staged("a.jpg"), owner: owner) }
        try area.remove(staged("a.jpg"), owner: owner)
    }

    @Test func refusesSymlinksThatLeaveTheFolder() throws {
        let folder = try TempFolder()
        let area = try area(folder)
        let secret = folder.url.appending(path: "secret.jpg")
        try Data("abcd".utf8).write(to: secret)
        try FileManager.default.createSymbolicLink(at: area.folder(for: owner).appending(path: "out"), withDestinationURL: folder.url)
        #expect(throws: StagingArea.Problem.outsideStaging) { try area.open(staged("out/secret.jpg"), owner: owner) }
        #expect(throws: StagingArea.Problem.outsideStaging) { try area.remove(staged("out/secret.jpg"), owner: owner) }
        #expect(FileManager.default.fileExists(atPath: secret.path()))
    }
}
