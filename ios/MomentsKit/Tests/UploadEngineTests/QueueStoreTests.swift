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
        let first = item("a.jpg", at: 0), second = item("a.jpg", at: 5), lower = item("b.jpg")
        try store.save(first)
        try store.save(second)
        try JSONEncoder().encode(lower).write(to: folder.url.appending(path: "\(lower.id.uuidString.lowercased()).json"))
        #expect(try store.load() == .init(items: [first], quarantined: 2))
    }

    @Test func sweepsLeftoversFromInterruptedWrites() throws {
        let folder = try TempFolder()
        let store = QueueStore(directory: folder.url)
        try store.save(item())
        let leftover = folder.url.appending(path: "\(UUID().uuidString).json.sb-1234")
        try Data("partial".utf8).write(to: leftover)
        _ = try store.load()
        #expect(!FileManager.default.fileExists(atPath: leftover.path()))
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
    private func staged(_ path: String, size: Int64 = 4) -> QueuedUpload.StagedFile {
        .init(relativePath: path, size: size, contentType: "image/jpeg")!
    }

    @Test func resolvesAFileInsideTheFolder() throws {
        let folder = try TempFolder()
        let root = folder.url.appending(path: "staging")
        try FileManager.default.createDirectory(at: root.appending(path: "ev"), withIntermediateDirectories: true)
        try Data("abcd".utf8).write(to: root.appending(path: "ev/a.jpg"))
        let handle = try StagingArea(root: root).open(staged("ev/a.jpg"))
        #expect(try handle.readToEnd() == Data("abcd".utf8))
    }

    @Test func refusesMissingChangedAndNonFiles() throws {
        let folder = try TempFolder()
        let area = StagingArea(root: folder.url)
        try Data("abcd".utf8).write(to: folder.url.appending(path: "a.jpg"))
        try FileManager.default.createDirectory(at: folder.url.appending(path: "dir"), withIntermediateDirectories: true)
        #expect(throws: StagingArea.Problem.missing) { try area.open(staged("b.jpg")) }
        #expect(throws: StagingArea.Problem.sizeChanged) { try area.open(staged("a.jpg", size: 5)) }
        #expect(throws: StagingArea.Problem.notAFile) { try area.open(staged("dir")) }
    }

    @Test func refusesHardLinksFifosAndUnreadableFiles() throws {
        let folder = try TempFolder()
        let area = StagingArea(root: folder.url)
        let file = folder.url.appending(path: "a.jpg")
        try Data("abcd".utf8).write(to: file)
        try FileManager.default.linkItem(at: file, to: folder.url.appending(path: "b.jpg"))
        #expect(throws: StagingArea.Problem.notAFile) { try area.open(staged("b.jpg")) }

        #expect(mkfifo(folder.url.appending(path: "f.jpg").path(), 0o600) == 0)
        #expect(throws: StagingArea.Problem.notAFile) { try area.open(staged("f.jpg")) }

        let locked = folder.url.appending(path: "c.jpg")
        try Data("abcd".utf8).write(to: locked)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: locked.path())
        #expect(throws: StagingArea.Problem.unreadable) { try area.open(staged("c.jpg")) }
    }

    @Test func refusesSymlinksThatLeaveTheFolder() throws {
        let folder = try TempFolder()
        let root = folder.url.appending(path: "staging")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let secret = folder.url.appending(path: "secret.jpg")
        try Data("abcd".utf8).write(to: secret)
        try FileManager.default.createSymbolicLink(at: root.appending(path: "a.jpg"), withDestinationURL: secret)
        try FileManager.default.createSymbolicLink(at: root.appending(path: "up"), withDestinationURL: folder.url)
        let area = StagingArea(root: root)
        #expect(throws: StagingArea.Problem.outsideStaging) { try area.open(staged("a.jpg")) }
        #expect(throws: StagingArea.Problem.outsideStaging) { try area.open(staged("up/secret.jpg")) }
    }

    @Test func refusesAPrefixLookalikeFolder() throws {
        let folder = try TempFolder()
        let root = folder.url.appending(path: "staging")
        let sibling = folder.url.appending(path: "staging-other")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: true)
        try Data("abcd".utf8).write(to: sibling.appending(path: "a.jpg"))
        try FileManager.default.createSymbolicLink(at: root.appending(path: "s"), withDestinationURL: sibling)
        #expect(throws: StagingArea.Problem.outsideStaging) { try StagingArea(root: root).open(staged("s/a.jpg")) }
    }
}
