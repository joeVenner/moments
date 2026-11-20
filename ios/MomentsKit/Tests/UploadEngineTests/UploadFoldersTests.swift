import Foundation
import Testing
@testable import UploadEngine

@Suite struct UploadFoldersTests {
    @Test func setsUpBothFoldersUnderABase() throws {
        let base = FileManager.default.temporaryDirectory.appending(path: "folders-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: base) }
        let folders = try UploadFolders.under(base)
        #expect(folders.store.directory == base.appending(path: "UploadQueue", directoryHint: .isDirectory))
        #expect(folders.staging.root == base.appending(path: "UploadStaging", directoryHint: .isDirectory))
        for folder in [folders.store.directory, folders.staging.root] {
            let values = try folder.resourceValues(forKeys: [.isDirectoryKey, .isExcludedFromBackupKey])
            #expect(values.isDirectory == true)
            #expect(values.isExcludedFromBackup == true)
        }
    }

    @Test func settingUpAgainKeepsWhatIsThere() throws {
        let base = FileManager.default.temporaryDirectory.appending(path: "folders-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: base) }
        let first = try UploadFolders.under(base)
        let id = UUID()
        try FileManager.default.createDirectory(at: first.staging.folder(for: id), withIntermediateDirectories: true)
        try Data("photo".utf8).write(to: first.staging.folder(for: id).appending(path: "a.jpg"))
        try Data("{}".utf8).write(to: first.store.recordURL(for: id))
        let again = try UploadFolders.under(base)
        #expect(try again.store.recordIDs() == [id])
        #expect(try Data(contentsOf: again.staging.folder(for: id).appending(path: "a.jpg")) == Data("photo".utf8))
    }

    /// Checked before any container is looked up (a test run would get a
    /// real one on a Mac).
    @Test(arguments: [nil, "", "com.moments-hq.moments", "group.", "group.moments", "group.a/../b.c", "group.a.b/c"])
    func refusesAnInvalidGroup(_ group: String?) throws {
        #expect(UploadFolders.clipBase(appGroup: group) == nil)
        #expect(try UploadFolders.clip(appGroup: group) == nil)
    }
}
