import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import UploadEngine

/// The app taking over the App Clip's leftover queue at launch.
@Suite struct ClipQueueLaunchTests {
    private let folder: TempFolder
    private let clip: UploadFolders
    private let app: UploadFolders

    init() throws {
        folder = try TempFolder()
        clip = try UploadFolders.under(folder.url.appending(path: "clip", directoryHint: .isDirectory))
        app = try UploadFolders.under(folder.url.appending(path: "app", directoryHint: .isDirectory))
    }

    private static let week: TimeInterval = 7 * 24 * 60 * 60
    private static let now = Date(timeIntervalSince1970: 1_000_000 + 2 * week)

    /// A queued item for `slug` with its staged file, in the Clip's queue,
    /// two weeks old by default.
    private func leave(for slug: String, createdAt: Date = Date(timeIntervalSince1970: 1_000_000)) throws -> QueuedUpload {
        let id = UUID()
        let item = QueuedUpload(
            id: id, eventSlug: slug,
            file: .init(relativePath: StagingArea.relativePath(for: id, name: "a.jpg"), size: 5, contentType: "image/jpeg")!,
            caption: nil, createdAt: createdAt
        )
        try FileManager.default.createDirectory(at: clip.staging.folder(for: id), withIntermediateDirectories: true)
        try Data("photo".utf8).write(to: clip.staging.folder(for: id).appending(path: "a.jpg"))
        try clip.store.save(item)
        return item
    }

    private func stagedExists(_ folders: UploadFolders, _ id: UUID) -> Bool {
        FileManager.default.fileExists(atPath: folders.staging.folder(for: id).appending(path: "a.jpg").path(percentEncoded: false))
    }

    private func answering(_ answers: [String: CredentialsLookupResult]) -> UploadLaunch.ClipQueue {
        UploadLaunch.ClipQueue(folders: clip, strangersKeptFor: Self.week, now: Self.now) { answers[$0] ?? .missing }
    }

    @Test func movesOnlyItemsOfEventsWithAGuestAndDropsTheRest() async throws {
        let joined = try leave(for: "party")
        let stranger = try leave(for: "elsewhere")
        let adoption = await UploadLaunch.adoptClipQueue(
            answering(["party": .found(EventCredentials(guestToken: "gt-test"))]), into: app.store, staging: app.staging
        )
        #expect(adoption == .init(moved: .init(adopted: 1), dropped: 1))
        #expect(try app.store.recordIDs() == [joined.id])
        #expect(stagedExists(app, joined.id))
        // Never uploaded, and its bytes are gone from the shared folder.
        #expect(try clip.store.recordIDs().isEmpty)
        #expect(!stagedExists(clip, stranger.id))
        #expect(!stagedExists(app, stranger.id))
    }

    @Test func leavesWhatItCantCheckNow() async throws {
        let item = try leave(for: "party")
        let adoption = await UploadLaunch.adoptClipQueue(answering(["party": .unavailable]), into: app.store, staging: app.staging)
        #expect(adoption == .init(moved: .init(skipped: 1)))
        #expect(try clip.store.recordIDs() == [item.id])
        #expect(stagedExists(clip, item.id))
        #expect(try app.store.recordIDs().isEmpty)
    }

    @Test func dropsARecordThatCanNeverBeRead() async throws {
        let id = UUID()
        try Data("not a record".utf8).write(to: clip.store.recordURL(for: id))
        try FileManager.default.createDirectory(at: clip.staging.folder(for: id), withIntermediateDirectories: true)
        let adoption = await UploadLaunch.adoptClipQueue(answering([:]), into: app.store, staging: app.staging)
        #expect(adoption == .init(dropped: 1))
        #expect(try clip.store.recordIDs().isEmpty)
        #expect(try app.store.recordIDs().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: clip.staging.folder(for: id).path(percentEncoded: false)))
    }

    @Test(arguments: [true, false])
    func asksOncePerEvent(isLocked: Bool) async throws {
        _ = try leave(for: "party")
        _ = try leave(for: "party")
        let asked = Counter()
        let queue = UploadLaunch.ClipQueue(folders: clip, strangersKeptFor: Self.week, now: Self.now) { _ in
            asked.add()
            return isLocked ? .unavailable : .found(EventCredentials(guestToken: "gt-test"))
        }
        let adoption = await UploadLaunch.adoptClipQueue(queue, into: app.store, staging: app.staging)
        #expect(adoption == (isLocked ? .init(moved: .init(skipped: 2)) : .init(moved: .init(adopted: 2))))
        #expect(asked.value == 1)
    }

    /// Its guest may still arrive (a handover that couldn't be read this
    /// time): kept, not adopted, until the handover window has passed.
    @Test func keepsARecentStrangerForLater() async throws {
        let recent = try leave(for: "elsewhere", createdAt: Self.now.addingTimeInterval(-Self.week + 60))
        let adoption = await UploadLaunch.adoptClipQueue(answering([:]), into: app.store, staging: app.staging)
        #expect(adoption == .init(moved: .init(skipped: 1)))
        #expect(try clip.store.recordIDs() == [recent.id])
        #expect(stagedExists(clip, recent.id))
        #expect(try app.store.recordIDs().isEmpty)
    }

    @Test func aRecordNotCheckedStays() throws {
        let checked = try leave(for: "party")
        let late = try leave(for: "party")
        let report = try QueueAdoption.adopt(
            from: clip.store, staging: clip.staging, into: app.store, staging: app.staging, admitting: [checked.id]
        )
        #expect(report == .init(adopted: 1, skipped: 1))
        #expect(try clip.store.recordIDs() == [late.id])
        #expect(stagedExists(clip, late.id))
    }

    @Test func prepareAdoptsBeforeLoading() async throws {
        let item = try leave(for: "party")
        let server = FakeUploadServer()
        let queue = UploadQueue(
            store: app.store, staging: app.staging, service: server, partUploader: server,
            credentials: { _ in .found(EventCredentials(guestToken: "gt-test")) }, thumbnailSender: FakeThumbnailSender()
        )
        let report = await UploadLaunch.prepare(
            queue: queue, store: app.store, staging: app.staging, launchedAt: Date().addingTimeInterval(60),
            adopting: answering(["party": .found(EventCredentials(guestToken: "gt-test"))])
        )
        #expect(report.adoption == .init(moved: .init(adopted: 1)))
        #expect(report.loaded?.items.map(\.id) == [item.id])
        // Its folder now has a record here, so the sweep keeps it.
        #expect(report.swept == 0)
        #expect(stagedExists(app, item.id))
    }

    @Test func dropsAFutureDatedStranger() async throws {
        let planted = try leave(for: "elsewhere", createdAt: Self.now.addingTimeInterval(UploadLaunch.futureSkew + 60))
        let skewed = try leave(for: "elsewhere", createdAt: Self.now.addingTimeInterval(UploadLaunch.futureSkew - 60))
        let adoption = await UploadLaunch.adoptClipQueue(answering([:]), into: app.store, staging: app.staging)
        #expect(adoption == .init(moved: .init(skipped: 1), dropped: 1))
        #expect(try clip.store.recordIDs() == [skewed.id])
        #expect(!stagedExists(clip, planted.id))
    }

    /// The Clip's own launch: finished and stale records go, with their
    /// files; a recent failure stays for the guest to retry.
    @Test func theClipPrunesItsOwnQueue() async throws {
        var done = try leave(for: "party", createdAt: Self.now)
        let session = { (status: UploadSession.Status, momentID: String?) in
            UploadSession(
                id: "u1", clientUploadID: done.clientUploadID, status: status, contentType: "image/jpeg",
                size: 5, partSize: 8 * 1024 * 1024, partCount: 1, createdAt: Self.now, momentID: momentID
            )
        }
        done.apply(.sessionStarted(session(.open, nil)), now: Self.now)
        done.apply(.completeAnswered(.completed(session(.completed, "m1"))), now: Self.now)
        #expect(done.phase == .done(momentID: "m1"))
        try clip.store.save(done)
        let old = try leave(for: "party", createdAt: Self.now.addingTimeInterval(-Self.week - 60))
        let future = try leave(for: "party", createdAt: Self.now.addingTimeInterval(UploadLaunch.futureSkew + 60))
        let recent = try leave(for: "party", createdAt: Self.now.addingTimeInterval(-Self.week + 60))

        UploadLaunch.prune(clip.store, staleAfter: Self.week, now: Self.now)

        #expect(try clip.store.recordIDs() == [recent.id])
        #expect(stagedExists(clip, old.id) && stagedExists(clip, future.id))
        // Their folders now have no record: the launch sweep removes them.
        let swept = try clip.staging.sweepItemFolders(keeping: clip.store.recordIDs(), createdBefore: .distantFuture)
        #expect(swept == 3)
        #expect(stagedExists(clip, recent.id))
    }

    /// Can't tell what it is: never taken for stale.
    @Test func pruningLeavesARecordItCantRead() throws {
        let item = try leave(for: "party", createdAt: Self.now.addingTimeInterval(-2 * Self.week))
        // Written by a newer app: not read now.
        try Data(#"{"schemaVersion": 999}"#.utf8).write(to: clip.store.recordURL(for: item.id))
        UploadLaunch.prune(clip.store, staleAfter: Self.week, now: Self.now)
        #expect(try clip.store.recordIDs() == [item.id])
    }

    @Test func prepareRemovesStaleItemsAndTheirFiles() async throws {
        // Real dates: the sweep after loading keeps folders made after launch.
        let launchedAt = Date().addingTimeInterval(60)
        let old = try leave(for: "party", createdAt: launchedAt.addingTimeInterval(-Self.week - 60))
        let recent = try leave(for: "party", createdAt: launchedAt.addingTimeInterval(-60))
        let server = FakeUploadServer()
        let queue = UploadQueue(
            store: clip.store, staging: clip.staging, service: server, partUploader: server,
            credentials: { _ in .found(EventCredentials(guestToken: "gt-test")) }, thumbnailSender: FakeThumbnailSender()
        )
        let report = await UploadLaunch.prepare(
            queue: queue, store: clip.store, staging: clip.staging, launchedAt: launchedAt, pruningAfter: Self.week
        )
        #expect(report.loaded?.items.map(\.id) == [recent.id])
        #expect(!stagedExists(clip, old.id))
        #expect(stagedExists(clip, recent.id))
    }

    @Test func findsOnlyARealFolder() throws {
        let base = folder.url.appending(path: "clip", directoryHint: .isDirectory)
        #expect(UploadFolders.existing(at: base)?.store.directory == clip.store.directory)
        #expect(UploadFolders.existing(at: folder.url.appending(path: "none", directoryHint: .isDirectory)) == nil)
        let link = folder.url.appending(path: "link", directoryHint: .isDirectory)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: base)
        #expect(UploadFolders.existing(at: link) == nil)
        // Nothing is created for a missing one.
        #expect(!FileManager.default.fileExists(atPath: folder.url.appending(path: "none").path(percentEncoded: false)))
        let file = folder.url.appending(path: "file", directoryHint: .notDirectory)
        try Data().write(to: file)
        #expect(UploadFolders.existing(at: file) == nil)
    }

    @Test func refusesAStagingFolderThatIsALink() throws {
        let base = folder.url.appending(path: "planted", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        // Nothing queued yet: either folder may be missing.
        #expect(UploadFolders.existing(at: base) != nil)
        try FileManager.default.createSymbolicLink(at: base.appending(path: "UploadStaging"), withDestinationURL: app.staging.root)
        #expect(UploadFolders.existing(at: base) == nil)
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func add() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
}
