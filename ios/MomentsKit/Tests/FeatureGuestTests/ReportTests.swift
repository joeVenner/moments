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
