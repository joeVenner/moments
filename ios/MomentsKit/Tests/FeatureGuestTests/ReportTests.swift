import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import FeatureGuest

private let slug = EventSlug("party")!
private let event = Event(id: "e1", slug: "party", title: "Party", type: "party", createdAt: .distantPast)
private let guest = Participant(id: "p1", eventID: "e1", nickname: "Lea", joinedAt: .distantPast)

private func photo(_ id: String) -> Moment {
    Moment(
        id: id, eventID: "e1", uploaderName: "Sara", pointsAwarded: 1, createdAt: .distantPast, seq: 1, changeSeq: 1,
        media: Media(kind: .image, url: "https://moments-hq.com/media/\(id).jpg")
    )
}

@Suite struct ReportOutcomeTests {
    @Test(arguments: [
        (MomentsAPIError.momentNotFound, ReportOutcome.gone),
        (.rateLimited, .busy),
        (.guestRequired, .ended),
        (.accessRequired, .ended),
        (.eventNotFound, .ended),
        (.eventNotHosted, .ended),
        (.transport(nil), .failed),
        (.unexpectedResponse, .failed),
    ])
    func readsTheError(_ error: MomentsAPIError, _ expected: ReportOutcome) {
        #expect(ReportOutcome(error) == expected)
    }

    @Test func saysNothingWhenTheScreenGoesAway() {
        #expect(ReportOutcome(CancellationError()) == .cancelled)
        #expect(ReportOutcome.ended.message == nil && ReportOutcome.cancelled.message == nil)
        for outcome in [ReportOutcome.reported, .gone, .busy, .failed] {
            #expect(outcome.message != nil, "\(outcome)")
        }
    }
}

@Suite @MainActor struct FeedReportTests {
    private func loaded(store: InMemoryEventCredentialStore) async -> (FeedModel, FakeService) {
        let service = FakeService()
        let model = FeedModel(event: event, participant: guest, slug: slug, service: service, store: store)
        service.pageResults = [.success(FeedPage(moments: [photo("m1")], nextBefore: nil, cursor: 10))]
        await model.loadFirstPage()
        return (model, service)
    }

    private var joined: InMemoryEventCredentialStore {
        InMemoryEventCredentialStore([slug: StoredEventCredentials(
            eventID: "e1", guestToken: "gt_me", participantID: "p1", nickname: "Lea"
        )])
    }

    @Test func reportsWithTheGuestsToken() async {
        let (model, service) = await loaded(store: joined)
        #expect(await model.report(momentID: "m1") == .reported)
        #expect(service.reportCalls.map(\.momentID) == ["m1"])
        #expect(service.reportCalls.first?.credentials.guestToken == "gt_me")
        #expect(model.phase == .loaded)
    }

    @Test func aGoneMomentOrABusyServerKeepsTheFeed() async {
        let (model, service) = await loaded(store: joined)
        service.reportResults = [.failure(MomentsAPIError.momentNotFound), .failure(MomentsAPIError.rateLimited)]
        #expect(await model.report(momentID: "m1") == .gone)
        #expect(await model.report(momentID: "m1") == .busy)
        #expect(model.phase == .loaded)
    }

    @Test func aRefusedGuestEndsTheFeedAndForgetsTheToken() async {
        let store = joined
        let (model, service) = await loaded(store: store)
        service.reportResults = [.failure(MomentsAPIError.guestRequired)]
        #expect(await model.report(momentID: "m1") == .ended)
        #expect(model.phase == .guestRequired)
        #expect(store.credentials(for: slug)?.guestToken == nil)
    }
}

@Suite @MainActor struct HighlightsReportTests {
    @Test func reportsAndPassesEventEndingErrorsToTheFeed() async {
        let service = FakeService()
        let model = HighlightsModel(slug: slug, service: service, store: InMemoryEventCredentialStore())
        var fatal: [MomentsAPIError] = []
        model.onFatalError = { fatal.append($0 as! MomentsAPIError) }
        service.reportResults = [.success(()), .failure(MomentsAPIError.momentNotFound), .failure(MomentsAPIError.guestRequired)]
        #expect(await model.report(momentID: "m1") == .reported)
        #expect(await model.report(momentID: "m1") == .gone)
        #expect(fatal.isEmpty && !model.hasEnded)
        #expect(await model.report(momentID: "m1") == .ended)
        #expect(fatal == [.guestRequired])
        #expect(model.hasEnded)
    }
}

@Suite @MainActor struct ReportHidingTests {
    private var joined: InMemoryEventCredentialStore {
        InMemoryEventCredentialStore([slug: StoredEventCredentials(
            eventID: "e1", guestToken: "gt_me", participantID: "p1", nickname: "Lea"
        )])
    }

    private func feed(store: InMemoryEventCredentialStore, moments: [String] = ["m1", "m2"]) async -> (FeedModel, FakeService) {
        let service = FakeService()
        let model = FeedModel(event: event, participant: guest, slug: slug, service: service, store: store)
        service.pageResults = [.success(FeedPage(moments: moments.map(photo), nextBefore: nil, cursor: 10))]
        await model.loadFirstPage()
        return (model, service)
    }

    @Test func aReportedMomentStaysUntilTheViewerCloses() async {
        let store = joined
        let (model, _) = await feed(store: store)
        #expect(await model.report(momentID: "m1") == .reported)
        // Still there: the viewer is showing it, with the thanks message.
        #expect(Set(model.moments.map(\.id)) == ["m1", "m2"])
        model.viewerDidClose()
        #expect(model.moments.map(\.id) == ["m2"])
        #expect(store.credentials(for: slug)?.reportedMomentIDs == ["m1"])
    }

    @Test func showingTheFeedAgainWhileTheViewerIsOpenKeepsTheReportedMoment() async {
        let store = joined
        let (model, _) = await feed(store: store)
        #expect(await model.report(momentID: "m1") == .reported)
        model.reloadHidden()
        #expect(Set(model.moments.map(\.id)) == ["m1", "m2"])
        model.viewerDidClose()
        #expect(model.moments.map(\.id) == ["m2"])
    }

    @Test func aReportHidesTheMomentEvenWhenTheDeviceCantSaveIt() async {
        let store = FlakyStore()
        let service = FakeService()
        let model = FeedModel(event: event, participant: guest, slug: slug, service: service, store: store)
        service.pageResults = [.success(FeedPage(moments: [photo("m1"), photo("m2")], nextBefore: nil, cursor: 10))]
        await model.loadFirstPage()
        store.failWrites = true
        #expect(await model.report(momentID: "m1") == .reported)
        model.viewerDidClose()
        #expect(model.moments.map(\.id) == ["m2"])
    }

    @Test func whenEveryLoadedMomentIsReportedOlderOnesStillLoad() async {
        let store = joined
        try? store.update(for: slug) { $0.rememberReport(of: "m1") }
        let service = FakeService()
        let model = FeedModel(event: event, participant: guest, slug: slug, service: service, store: store)
        service.pageResults = [
            .success(FeedPage(moments: [photo("m1")], nextBefore: 1, cursor: 10)),
            .success(FeedPage(moments: [photo("m0")], nextBefore: nil, cursor: 10)),
        ]
        await model.loadFirstPage()
        for _ in 0..<200 where model.moments.isEmpty { await Task.yield() }
        #expect(model.canLoadOlder == false)
        #expect(model.moments.map(\.id) == ["m0"])
    }

    @Test func aFailedReportHidesNothing() async {
        let store = joined
        let (model, service) = await feed(store: store)
        service.reportResults = [.failure(MomentsAPIError.transport(nil))]
        #expect(await model.report(momentID: "m1") == .failed)
        model.viewerDidClose()
        #expect(Set(model.moments.map(\.id)) == ["m1", "m2"])
        #expect(store.credentials(for: slug)?.reportedMomentIDs == nil)
    }

    @Test func savedReportsAreHiddenFromTheStart() async {
        let store = joined
        try? store.update(for: slug) { $0.rememberReport(of: "m2") }
        let (model, _) = await feed(store: store)
        #expect(model.moments.map(\.id) == ["m1"])
    }

    @Test func aReportFromHighlightsReachesTheFeedAndBack() async {
        let store = joined
        let (model, _) = await feed(store: store)
        let service = FakeService()
        service.highlightsResults = [.success([photo("m1"), photo("m2")])]
        let highlights = HighlightsModel(slug: slug, service: service, store: store)
        await highlights.loadIfStale()
        #expect(await highlights.report(momentID: "m2") == .reported)
        highlights.viewerDidClose()
        #expect(highlights.moments.map(\.id) == ["m1"])
        // The feed picks it up when shown again.
        #expect(Set(model.moments.map(\.id)) == ["m1", "m2"])
        model.reloadHidden()
        #expect(model.moments.map(\.id) == ["m1"])
        // And the other way: highlights picks up a feed report when shown.
        #expect(await model.report(momentID: "m1") == .reported)
        model.viewerDidClose()
        await highlights.loadIfStale()
        #expect(highlights.moments.isEmpty)
    }
}

@Suite struct ReportMemoryTests {
    @Test func remembersEachReportOnceAndOnlyTheNewest() {
        var stored = StoredEventCredentials(guestToken: "gt")
        stored.rememberReport(of: "a")
        stored.rememberReport(of: "a")
        #expect(stored.reportedMomentIDs == ["a"])
        for index in 0..<StoredEventCredentials.reportedMomentLimit { stored.rememberReport(of: "m\(index)") }
        #expect(stored.reportedMomentIDs?.count == StoredEventCredentials.reportedMomentLimit)
        #expect(stored.reportedMomentIDs?.first == "m0" && stored.reportedMomentIDs?.last == "m199")
    }
}
