import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import FeatureGuest

private let slug = EventSlug("party")!
private let event = Event(id: "e1", slug: "party", title: "Party", type: "party", createdAt: .distantPast)
private let guest = Participant(id: "p1", eventID: "e1", nickname: "Lea", joinedAt: .distantPast)

private func moment(_ seq: Int) -> Moment {
    Moment(
        id: "m\(seq)", eventID: "e1", uploaderName: "Lea", pointsAwarded: 1, createdAt: .distantPast,
        seq: seq, changeSeq: seq, media: Media(kind: .image, url: "https://moments-hq.com/media/\(seq).jpg")
    )
}

/// Newest first, like the server.
private func page(_ seqs: ClosedRange<Int>, nextBefore: Int? = nil, cursor: Int = 100) -> FeedPage {
    FeedPage(moments: seqs.reversed().map(moment), nextBefore: nextBefore, cursor: cursor)
}

@MainActor
private func makeModel(store: InMemoryEventCredentialStore = .init()) -> (FeedModel, FakeService) {
    let service = FakeService()
    return (FeedModel(event: event, participant: guest, slug: slug, reactorID: "r1", service: service, store: store), service)
}

@Suite @MainActor struct FeedModelTests {
    @Test func firstPageLoadsWithStoredCredentials() async {
        let store = InMemoryEventCredentialStore([slug: StoredEventCredentials(
            eventID: "e1", accessGrant: "grant", accessGrantExpiresAt: Date(timeIntervalSinceNow: 3600), guestToken: "gt"
        )])
        let (model, service) = makeModel(store: store)
        service.pageResults = [.success(page(1...3))]
        await model.loadFirstPage()
        #expect(model.phase == .loaded)
        #expect(model.moments.map(\.seq) == [3, 2, 1])
        let call = service.pageCalls.first
        #expect(call?.before == nil && call?.reactorID == "r1")
        #expect(call?.credentials == EventCredentials(accessGrant: "grant", guestToken: "gt"))
        #expect(model.mediaAccessGrant() == "grant")
    }

    @Test func pollCountsNewMomentsUntilRevealed() async {
        let (model, service) = makeModel()
        service.pageResults = [.success(page(1...3, cursor: 10))]
        service.changesResults = [.success(FeedChanges(upserts: [moment(4), moment(5)], removed: ["m1"], cursor: 12, hasMore: false))]
        await model.loadFirstPage()
        await model.poll()
        #expect(service.changesCalls == [10])
        // The hidden moment leaves at once; new ones wait behind the pill.
        #expect(model.moments.map(\.seq) == [3, 2])
        #expect(model.newMomentCount == 2)
        model.revealNewMoments()
        #expect(model.moments.map(\.seq) == [5, 4, 3, 2])
        #expect(model.newMomentCount == 0)
    }

    @Test func pollDrainsBatchesAndReloadsWhenTheServerRewinds() async {
        let (model, service) = makeModel()
        service.pageResults = [.success(page(1...2, cursor: 10)), .success(page(1...4, cursor: 3))]
        service.changesResults = [
            .success(FeedChanges(upserts: [moment(3)], removed: [], cursor: 11, hasMore: true)),
            .success(FeedChanges(upserts: [], removed: [], cursor: 2, hasMore: false)),
        ]
        await model.loadFirstPage()
        await model.poll()
        #expect(service.changesCalls == [10, 11])
        #expect(service.pageCalls.count == 2)
        // The reload keeps the guest's place: 3 and 4 still count as new.
        #expect(model.moments.map(\.seq) == [2, 1])
        #expect(model.newMomentCount == 2)
    }

    @Test func anEmptyFeedShowsArrivalsStraightAway() async {
        let (model, service) = makeModel()
        service.pageResults = [.success(FeedPage(moments: [], nextBefore: nil, cursor: 0))]
        service.changesResults = [.success(FeedChanges(upserts: [moment(1)], removed: [], cursor: 1, hasMore: false))]
        await model.loadFirstPage()
        #expect(model.moments.isEmpty)
        await model.poll()
        #expect(model.moments.map(\.seq) == [1])
        #expect(model.newMomentCount == 0)
    }

    @Test func refreshShowsEverything() async {
        let (model, service) = makeModel()
        service.pageResults = [.success(page(1...2, cursor: 10)), .success(page(1...5, cursor: 20))]
        service.changesResults = [.success(FeedChanges(upserts: [moment(3)], removed: [], cursor: 11, hasMore: false))]
        await model.loadFirstPage()
        await model.poll()
        #expect(model.newMomentCount == 1)
        await model.refresh()
        #expect(model.moments.map(\.seq) == [5, 4, 3, 2, 1])
        #expect(model.newMomentCount == 0)
        #expect(!model.isRefreshing)
    }

    @Test func olderPagesLoadNearTheEndOnly() async {
        let (model, service) = makeModel()
        service.pageResults = [.success(page(41...60, nextBefore: 41)), .success(page(21...40, nextBefore: nil))]
        await model.loadFirstPage()
        #expect(model.loadOlderIfNeeded(near: moment(60)) == nil)
        #expect(service.pageCalls.count == 1)
        await model.loadOlderIfNeeded(near: moment(45))?.value
        #expect(service.pageCalls.last?.before == 41)
        #expect(model.moments.count == 40)
        #expect(!model.canLoadOlder)
        await model.loadOlder()
        #expect(service.pageCalls.count == 2)
    }

    @Test func olderPageFailureIsKeptQuietAndRetryable() async {
        let (model, service) = makeModel()
        service.pageResults = [
            .success(page(41...60, nextBefore: 41)),
            .failure(MomentsAPIError.transport(.timedOut)),
            .success(page(21...40)),
        ]
        await model.loadFirstPage()
        await model.loadOlder()
        #expect(model.phase == .loaded && model.olderPageFailed)
        await model.loadOlder()
        #expect(!model.olderPageFailed && model.moments.count == 40)
    }

    @Test func pollErrorsKeepTheGridButLostAccessEndsIt() async {
        let (model, service) = makeModel()
        service.pageResults = [.success(page(1...2))]
        service.changesResults = [.failure(MomentsAPIError.transport(.timedOut)), .failure(MomentsAPIError.accessRequired)]
        await model.loadFirstPage()
        await model.poll()
        #expect(model.phase == .loaded)
        await model.poll()
        #expect(model.phase == .accessLost)
        await model.poll()
        #expect(service.changesCalls.count == 2)
    }

    @Test(arguments: [
        (MomentsAPIError.transport(.notConnectedToInternet), FeedModel.Phase.failed(.temporary)),
        (.eventNotFound, .failed(.eventGone)),
        (.accessRequired, .accessLost),
    ])
    func firstPageFailures(_ error: MomentsAPIError, _ expected: FeedModel.Phase) async {
        let (model, service) = makeModel()
        service.pageResults = [.failure(error), .success(page(1...1))]
        await model.loadFirstPage()
        #expect(model.phase == expected)
        await model.loadFirstPage()
        #expect(model.phase == (expected == .failed(.temporary) ? .loaded : expected))
    }

    @Test func pollingStopsWhenCancelled() async {
        let (model, service) = makeModel()
        service.pageResults = [.success(page(1...1))]
        await model.loadFirstPage()
        let task = Task { await model.pollUntilCancelled(every: .seconds(60)) }
        task.cancel()
        await task.value
        #expect(service.changesCalls.isEmpty)
    }

    @Test func anOlderPageFromBeforeARefreshIsDropped() async {
        let (model, service) = makeModel()
        let gate = Gate()
        service.pageResults = [
            .success(page(41...60, nextBefore: 41, cursor: 10)),
            .success(page(21...40, nextBefore: 21)),
            .success(page(51...70, nextBefore: 51, cursor: 20)),
        ]
        await model.loadFirstPage()
        service.beforePage = { before in if before == 41 { await gate.wait() } }
        let older = model.loadOlderIfNeeded(near: moment(45))
        await Task.yield()
        await model.refresh()
        await gate.open()
        await older?.value
        // 21...40 would sit below 51 with 41...50 missing: it must not land.
        #expect(model.moments.map(\.seq) == Array((51...70).reversed()))
        #expect(model.canLoadOlder)
        #expect(!model.olderPageFailed)
    }

    @Test func cancellingAnOlderPageIsNotAFailure() async {
        let (model, service) = makeModel()
        let gate = Gate()
        service.pageResults = [.success(page(41...60, nextBefore: 41)), .success(page(21...40))]
        await model.loadFirstPage()
        service.beforePage = { _ in await gate.wait() }
        let task = Task { await model.loadOlder() }
        await Task.yield()
        task.cancel()
        await gate.open()
        await task.value
        #expect(!model.olderPageFailed)
        #expect(!model.isLoadingOlder)
    }

    @Test func refreshWaitsForARunningPollAndReportsFailure() async {
        let (model, service) = makeModel()
        let gate = Gate()
        service.pageResults = [.success(page(1...2, cursor: 10)), .success(page(1...3, cursor: 11)), .failure(MomentsAPIError.transport(.timedOut))]
        service.changesResults = [.success(FeedChanges(upserts: [], removed: [], cursor: 10, hasMore: false))]
        await model.loadFirstPage()
        service.beforePage = { _ in await gate.wait() }
        // Hold the refresh's page open while a poll is already queued behind it.
        async let refreshed: Void = model.refresh()
        await Task.yield()
        await model.poll()
        await gate.open()
        await refreshed
        #expect(model.moments.map(\.seq) == [3, 2, 1])
        #expect(!model.refreshFailed)
        service.beforePage = nil
        await model.refresh()
        #expect(model.refreshFailed && model.phase == .loaded)
    }

    @Test func pollingEndsOnceTheFeedIsOver() async {
        let (model, service) = makeModel()
        service.pageResults = [.success(page(1...1))]
        service.changesResults = [.failure(MomentsAPIError.eventNotFound)]
        await model.loadFirstPage()
        await model.pollUntilCancelled(every: .milliseconds(1))
        #expect(model.phase == .failed(.eventGone))
        #expect(service.changesCalls.count == 1)
    }

    @Test func mediaGrantIsCachedBriefly() async throws {
        let store = InMemoryEventCredentialStore([slug: StoredEventCredentials(
            eventID: "e1", accessGrant: "grant", accessGrantExpiresAt: Date(timeIntervalSinceNow: 3600)
        )])
        let (model, _) = makeModel(store: store)
        #expect(model.mediaAccessGrant() == "grant")
        try store.update(for: slug) { $0.accessGrant = "newer" }
        #expect(model.mediaAccessGrant() == "grant")
    }

    @Test func olderLoadingRecoversAfterOverlappingStarts() async {
        let (model, service) = makeModel()
        let gate = Gate()
        service.pageResults = [
            .success(page(41...60, nextBefore: 41)),
            .success(page(21...40, nextBefore: 21)),
            .success(page(1...20)),
        ]
        await model.loadFirstPage()
        service.beforePage = { before in if before == 41 { await gate.wait() } }
        // "Try again" runs a load directly while a cell asks for one too.
        let direct = Task { await model.loadOlder() }
        await Task.yield()
        await model.loadOlderIfNeeded(near: moment(45))?.value
        await gate.open()
        await direct.value
        await model.loadOlderIfNeeded(near: moment(25))?.value
        #expect(model.moments.count == 60)
        #expect(!model.canLoadOlder)
    }

    @Test func grantCacheNeverOutlivesTheGrant() throws {
        let clock = Clock()
        let store = InMemoryEventCredentialStore([slug: StoredEventCredentials(
            eventID: "e1", accessGrant: "grant", accessGrantExpiresAt: clock.now.addingTimeInterval(70)
        )])
        let cache = GrantCache(store: store, slug: slug, now: { clock.now })
        #expect(cache.grant() == "grant")
        clock.advance(by: 15)
        #expect(cache.grant() == nil)
    }
}

private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_800_000_000)
    var now: Date { lock.withLock { current } }
    func advance(by seconds: TimeInterval) { lock.withLock { current += seconds } }
}
