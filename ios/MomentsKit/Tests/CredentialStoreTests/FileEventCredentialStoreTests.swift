import Foundation
import MomentsDomain
import Testing
@testable import CredentialStore

private let party = EventSlug("party")!

@Suite struct FileEventCredentialStoreTests {
    private let directory = FileManager.default.temporaryDirectory
        .appending(path: "moments-file-store-\(UUID().uuidString)", directoryHint: .isDirectory)
    private var file: URL { directory.appending(path: "event-credentials.json") }

    private func store() -> FileEventCredentialStore { FileEventCredentialStore(directory: directory) }

    /// Writes the file the way the store does, with raw entry bytes.
    private func plant(_ entries: [String: Data]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["version": 1, "entries": entries.mapValues { $0.base64EncodedString() }])
            .write(to: file)
    }

    @Test func behavesLikeEveryStore() async throws {
        defer { try? FileManager.default.removeItem(at: directory) }
        try exerciseStore(store())
        try exerciseEventIDBinding(store())
        try await exerciseConcurrentUpdates(store())
    }

    @Test func nothingStoredMeansNoFile() throws {
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = store()
        #expect(try store.storedSlugs().isEmpty)
        // A lookup that changes nothing writes nothing.
        try store.update(for: party) { _ in }
        #expect(!FileManager.default.fileExists(atPath: file.path))
        try store.save(sampleCredentials, for: party)
        #expect(FileManager.default.fileExists(atPath: file.path))
        try store.removeCredentials(for: party)
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }

    @Test func entriesSurviveANewStoreAndListSorted() throws {
        defer { try? FileManager.default.removeItem(at: directory) }
        var stamped = sampleCredentials
        stamped.handedOverAt = Date(timeIntervalSince1970: 2_000_000_000)
        try store().save(stamped, for: party)
        try store().save(sampleCredentials, for: EventSlug("aperitif")!)
        #expect(try store().credentials(for: party) == stamped)
        #expect(try store().storedSlugs().map(\.value) == ["aperitif", "party"])
    }

    @Test func theFileIsKeptOutOfBackups() throws {
        defer { try? FileManager.default.removeItem(at: directory) }
        try store().save(sampleCredentials, for: party)
        try store().save(sampleCredentials, for: EventSlug("wedding")!)
        #expect(try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    }

    @Test func aPartialChangeNeverDeletesAnUnreadableEntry() throws {
        defer { try? FileManager.default.removeItem(at: directory) }
        let newer = Data(#"{"schemaVersion":99,"guestToken":"gt_newer"}"#.utf8)
        try plant(["party": newer, "not a slug!": newer])
        let store = store()
        #expect(try store.credentials(for: party) == nil)
        #expect(try store.storedSlugs() == [party])
        #expect(try store.credentials(for: party, eventID: "e1") == nil)
        #expect(throws: FileEventCredentialStore.StoreError.unreadableItem) {
            try store.update(for: party) { $0.mute(participantID: "p2") }
        }
        // A join replaces it.
        try store.update(for: party) { $0.guestToken = "gt_new"; $0.participantID = "p1" }
        #expect(try store.credentials(for: party)?.guestToken == "gt_new")
    }

    @Test func aDamagedFileIsntWrittenOverUntilItIsStale() throws {
        defer { try? FileManager.default.removeItem(at: directory) }
        try plant(["wedding": try StoredEventCredentials.encode(sampleCredentials)])
        var damaged = try Data(contentsOf: file)
        damaged.removeLast(5)
        try damaged.write(to: file)
        let store = store()
        #expect(try store.storedSlugs().isEmpty)
        #expect(try store.credentials(for: party) == nil)
        #expect(throws: FileEventCredentialStore.StoreError.unreadableFile) { try store.save(sampleCredentials, for: party) }
        #expect(throws: FileEventCredentialStore.StoreError.unreadableFile) { try store.update(for: party) { $0.guestToken = "gt" } }
        #expect(throws: FileEventCredentialStore.StoreError.unreadableFile) { try store.removeCredentials(for: party) }
        #expect(try Data(contentsOf: file) == damaged)
        // Past the handover window it goes, and the store works again.
        let later = FileEventCredentialStore(directory: directory, now: { Date().addingTimeInterval(CredentialHandoff.handoffWindow + 60) })
        #expect(try later.storedSlugs().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: file.path))
        try later.save(sampleCredentials, for: party)
        #expect(try later.credentials(for: party) == sampleCredentials)
        // "Forget me" deletes a damaged file at once.
        try Data("not json".utf8).write(to: file)
        try store.removeAll()
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }

    @Test func aFileWithinTheWindowIsKept() throws {
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: file)
        let almost = FileEventCredentialStore(directory: directory, now: { Date().addingTimeInterval(CredentialHandoff.handoffWindow - 60) })
        #expect(try almost.storedSlugs().isEmpty)
        #expect(FileManager.default.fileExists(atPath: file.path))
    }

    @Test func aFileThatCantBeOpenedThrows() throws {
        defer { try? FileManager.default.removeItem(at: directory) }
        // A directory where the file should be: reading fails, unlike a missing file.
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: true)
        #expect(throws: (any Error).self) { try store().storedSlugs() }
        #expect(throws: (any Error).self) { try store().save(sampleCredentials, for: party) }
    }

    @Test(arguments: ["", "group.", "group.$(MOMENTS_BUNDLE_ID_PREFIX).moments", "com.moments-hq.moments", "group.moments"])
    func onlyAFilledInGroupNameIsUsed(_ name: String) {
        #expect(FileEventCredentialStore.handover(appGroup: name) == nil)
    }

    @Test func noGroupNameNoStore() {
        #expect(FileEventCredentialStore.handover(appGroup: nil) == nil)
    }

    @Test func aNewerBuildsFileIsNeitherReadNorReplaced() throws {
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let newer = Data(#"{"version":2,"slots":{"party":"x"}}"#.utf8)
        try newer.write(to: file)
        let store = store()
        #expect(throws: FileEventCredentialStore.StoreError.newerFormat) { try store.storedSlugs() }
        #expect(throws: FileEventCredentialStore.StoreError.newerFormat) { try store.save(sampleCredentials, for: party) }
        #expect(throws: FileEventCredentialStore.StoreError.newerFormat) { try store.removeCredentials(for: party) }
        #expect(try Data(contentsOf: file) == newer)
        // Past the handover window it goes.
        let later = FileEventCredentialStore(directory: directory, now: { Date().addingTimeInterval(CredentialHandoff.handoffWindow + 60) })
        #expect(try later.storedSlugs().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: file.path))
        try newer.write(to: file)
        // "Forget me" still works.
        try store.removeAll()
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }

    @Test func theClipsWritesReachTheApp() throws {
        defer { try? FileManager.default.removeItem(at: directory) }
        let clip = HandoverStampingStore(store())
        try clip.save(StoredEventCredentials(eventID: "e1", guestToken: "gt_clip", participantID: "p1"), for: party)
        let own = InMemoryEventCredentialStore()
        #expect(try CredentialHandoff.importFromClip(store(), into: own) == [party])
        #expect(own.credentials(for: party)?.guestToken == "gt_clip")
        #expect(own.credentials(for: party)?.handedOverAt == nil)
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }
}
