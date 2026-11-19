import Foundation
import Testing
@testable import UploadEngine

@Suite struct StagingSweepTests {
    let folder: TempFolder
    let staging: StagingArea

    init() throws {
        folder = try TempFolder()
        staging = StagingArea(root: folder.url)
    }

    private func makeItemFolder(_ id: UUID) throws -> URL {
        let url = staging.folder(for: id)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        try Data("photo".utf8).write(to: url.appending(path: "photo.jpg"))
        return url
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path(percentEncoded: false))
    }

    @Test func removesOnlyUnownedFoldersFromBeforeTheCutoff() throws {
        let owned = UUID(), orphan = UUID()
        let ownedURL = try makeItemFolder(owned)
        let orphanURL = try makeItemFolder(orphan)
        let other = folder.url.appending(path: "notes", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)

        let removed = try staging.sweepItemFolders(keeping: [owned], createdBefore: Date().addingTimeInterval(60))

        #expect(removed == 1)
        #expect(exists(ownedURL))
        #expect(!exists(orphanURL))
        #expect(exists(other)) // not an item folder
    }

    @Test func keepsAFolderBeingPreparedSinceLaunch() throws {
        let launch = Date().addingTimeInterval(-60)
        let fresh = try makeItemFolder(UUID())
        #expect(try staging.sweepItemFolders(keeping: [], createdBefore: launch) == 0)
        #expect(exists(fresh))
    }

    @Test func ignoresNonCanonicalNames() throws {
        let id = UUID()
        let lower = folder.url.appending(path: id.uuidString.lowercased(), directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: lower, withIntermediateDirectories: true)
        #expect(try staging.sweepItemFolders(keeping: [], createdBefore: Date().addingTimeInterval(60)) == 0)
        #expect(exists(lower))
    }

    @Test func removesALinkItselfNeverItsTarget() throws {
        let outside = try TempFolder()
        let target = outside.url.appending(path: "keep.jpg")
        try Data("keep".utf8).write(to: target)
        let link = folder.url.appending(path: UUID().uuidString, directoryHint: .notDirectory)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside.url)

        #expect(try staging.sweepItemFolders(keeping: [], createdBefore: Date().addingTimeInterval(60)) == 1)
        #expect(exists(target))
    }

    @Test func toleratesAMissingRoot() throws {
        let missing = StagingArea(root: folder.url.appending(path: "nope", directoryHint: .isDirectory))
        #expect(try missing.sweepItemFolders(keeping: [], createdBefore: Date()) == 0)
    }

    @Test func recordIDsListsEveryRecordOnDisk() throws {
        let store = QueueStore(directory: folder.url.appending(path: "queue", directoryHint: .isDirectory), maxItems: 1)
        let first = QueuedUpload(
            eventSlug: "party", file: .init(relativePath: "a.jpg", size: 10, contentType: "image/jpeg")!, caption: nil,
            createdAt: Date(timeIntervalSince1970: 0)
        )
        let second = QueuedUpload(
            eventSlug: "party", file: .init(relativePath: "b.jpg", size: 10, contentType: "image/jpeg")!, caption: nil,
            createdAt: Date(timeIntervalSince1970: 1)
        )
        try store.save(first)
        try store.save(second)
        try Data("{}".utf8).write(to: store.directory.appending(path: "junk.json"))

        // Over the cap, one isn't loaded, but it still owns its folder.
        #expect(try store.load().overflow == 1)
        #expect(try store.recordIDs() == [first.id, second.id])
    }

    @Test func recordIDsIsEmptyWithoutAQueueFolder() throws {
        let store = QueueStore(directory: folder.url.appending(path: "none", directoryHint: .isDirectory))
        #expect(try store.recordIDs().isEmpty)
    }
}
