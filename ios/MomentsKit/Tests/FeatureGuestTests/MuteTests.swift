import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import FeatureGuest

private let slug = EventSlug("party")!
private let event = Event(id: "e1", slug: "party", title: "Party", type: "party", createdAt: .distantPast)
private let guest = Participant(id: "p1", eventID: "e1", nickname: "Lea", joinedAt: .distantPast)

/// `by` is the sharer's participant id (nil: a moment from before guest ids).
private func photo(_ id: String, by uploaderID: String?) -> Moment {
    Moment(
        id: id, eventID: "e1", uploaderName: uploaderID?.uppercased() ?? "Old", uploaderID: uploaderID,
        pointsAwarded: 1, createdAt: .distantPast, seq: 1, changeSeq: 1,
        media: Media(kind: .image, url: "https://moments-hq.com/media/\(id).jpg")
    )
}

/// Sara (p2) shared s1 and s2, Lea (this guest, p1) shared mine, and old has no id.
private let page = [photo("s1", by: "p2"), photo("mine", by: "p1"), photo("s2", by: "p2"), photo("old", by: nil)]

private func joined() -> InMemoryEventCredentialStore {
    InMemoryEventCredentialStore([slug: StoredEventCredentials(
        eventID: "e1", guestToken: "gt_me", participantID: "p1", nickname: "Lea"
    )])
}

@MainActor
private func feed(store: any EventCredentialStore, moments: [Moment] = page) async -> FeedModel {
    let service = FakeService()
    let model = FeedModel(event: event, participant: guest, slug: slug, service: service, store: store)
    service.pageResults = [.success(FeedPage(moments: moments, nextBefore: nil, cursor: 10))]
    await model.loadFirstPage()
    return model
}

private func ids(_ moments: [Moment]) -> Set<String> { Set(moments.map(\.id)) }

@Suite @MainActor struct MuteTests {
    @Test func onlyOtherGuestsWithAnIDCanBeMuted() async {
        let model = await feed(store: joined())
        #expect(model.canMute(photo("x", by: "p2")))
        #expect(!model.canMute(photo("x", by: "p1")))
        #expect(!model.canMute(photo("x", by: nil)))
    }

    @Test func aMutedGuestsMomentsGoWhenTheViewerCloses() async {
        let store = joined()
        let model = await feed(store: store)
        model.mute(participantID: "p2")
        // Still there: the viewer is showing one, with the message.
        #expect(ids(model.moments) == ["s1", "mine", "s2", "old"])
        model.viewerDidClose()
        #expect(ids(model.moments) == ["mine", "old"])
        #expect(store.credentials(for: slug)?.mutedParticipantIDs == ["p2"])
    }

    @Test func showingTheFeedAgainWhileTheViewerIsOpenKeepsTheMutedGuest() async {
        let model = await feed(store: joined())
        model.mute(participantID: "p2")
        model.reloadHidden()
        #expect(ids(model.moments) == ["s1", "mine", "s2", "old"])
        model.viewerDidClose()
        #expect(ids(model.moments) == ["mine", "old"])
    }

    @Test func savedMutesAreHiddenFromTheStartAndUnmutingBringsThemBack() async {
        let store = joined()
        try? store.update(for: slug) { $0.mute(participantID: "p2") }
        let model = await feed(store: store)
        #expect(ids(model.moments) == ["mine", "old"])
        try? store.update(for: slug) { $0.unmute(participantID: "p2") }
        model.reloadHidden()
        #expect(ids(model.moments) == ["s1", "mine", "s2", "old"])
    }

    @Test func thisGuestIsNeverMutedEvenBySavedData() async {
        let store = joined()
        // A stray saved id for this guest hides nothing.
        try? store.update(for: slug) { $0.mute(participantID: "p1") }
        let model = await feed(store: store)
        #expect(ids(model.moments) == ["s1", "mine", "s2", "old"])
        model.mute(participantID: "p1")
        model.viewerDidClose()
        #expect(ids(model.moments) == ["s1", "mine", "s2", "old"])
        #expect(store.credentials(for: slug)?.mutedParticipantIDs == ["p1"])
    }

    @Test func thisGuestCantMuteThemselves() async {
        let store = joined()
        let model = await feed(store: store)
        model.mute(participantID: "p1")
        #expect(store.credentials(for: slug)?.mutedParticipantIDs == nil)
    }

    @Test func aMuteFromTheViewerAppliesEvenIfTheStoreCantBeReadOnClose() async {
        let store = FlakyStore()
        try? store.save(StoredEventCredentials(guestToken: "gt_me", participantID: "p1"), for: slug)
        let model = await feed(store: store)
        model.mute(participantID: "p2")
        store.failReads = true
        model.viewerDidClose()
        #expect(ids(model.moments) == ["mine", "old"])
    }

    @Test func anUnsavedMuteAppliesWhenTheViewerClosesAndCanBeLeftBehind() async {
        let store = FlakyStore()
        try? store.save(StoredEventCredentials(guestToken: "gt_me", participantID: "p1"), for: slug)
        let model = await feed(store: store)
        store.failWrites = true
        model.mute(participantID: "p2")
        model.viewerDidClose()
        #expect(ids(model.moments) == ["mine", "old"])
        // Not in the muted guests list, so it can't outlive a reload (it
        // could never be unmuted).
        model.reloadHidden()
        #expect(ids(model.moments) == ["s1", "mine", "s2", "old"])
    }

    @Test func highlightsKnowsThisGuestEvenWhenTheStoreCantBeRead() async {
        let store = FlakyStore()
        store.failReads = true
        let highlights = HighlightsModel(slug: slug, participantID: "p1", service: FakeService(), store: store)
        #expect(!highlights.canMute(photo("x", by: "p1")))
    }

    @Test func anUnreadableStoreKeepsWhatWasHidden() async {
        let store = FlakyStore()
        try? store.save(StoredEventCredentials(guestToken: "gt_me", participantID: "p1"), for: slug)
        try? store.update(for: slug) { $0.mute(participantID: "p2") }
        let model = await feed(store: store)
        store.failReads = true
        model.reloadHidden()
        #expect(ids(model.moments) == ["mine", "old"])
        model.viewerDidClose()
        #expect(ids(model.moments) == ["mine", "old"])
    }

    @Test func whenEveryLoadedMomentIsMutedOlderOnesStillLoad() async {
        let store = joined()
        try? store.update(for: slug) { $0.mute(participantID: "p2") }
        let service = FakeService()
        let model = FeedModel(event: event, participant: guest, slug: slug, service: service, store: store)
        service.pageResults = [
            .success(FeedPage(moments: [photo("s1", by: "p2")], nextBefore: 1, cursor: 10)),
            .success(FeedPage(moments: [photo("m0", by: "p3")], nextBefore: nil, cursor: 10)),
        ]
        await model.loadFirstPage()
        for _ in 0..<200 where model.moments.isEmpty { await Task.yield() }
        #expect(model.moments.map(\.id) == ["m0"])
    }

    @Test func aMuteFromHighlightsReachesTheFeedAndAnUnmuteComesBack() async {
        let store = joined()
        let model = await feed(store: store)
        let service = FakeService()
        service.highlightsResults = [.success(page)]
        let highlights = HighlightsModel(slug: slug, service: service, store: store)
        await highlights.loadIfStale()
        // Highlights reads this guest's id from the store.
        #expect(!highlights.canMute(photo("x", by: "p1")) && highlights.canMute(photo("x", by: "p2")))
        highlights.mute(participantID: "p2")
        #expect(ids(highlights.moments) == ["s1", "mine", "s2", "old"])
        highlights.viewerDidClose()
        #expect(ids(highlights.moments) == ["mine", "old"])
        model.reloadHidden()
        #expect(ids(model.moments) == ["mine", "old"])
        // Unmuted from the muted guests list.
        let leaderboard = LeaderboardModel(slug: slug, participantID: "p1", service: FakeService(), store: store)
        leaderboard.reloadMuted()
        #expect(leaderboard.mutedParticipantIDs == ["p2"])
        leaderboard.unmute(participantID: "p2")
        #expect(leaderboard.mutedParticipantIDs.isEmpty)
        highlights.reloadHidden()
        model.reloadHidden()
        #expect(ids(highlights.moments) == ["s1", "mine", "s2", "old"])
        #expect(ids(model.moments) == ["s1", "mine", "s2", "old"])
    }
}

@Suite @MainActor struct MutedGuestsTests {
    @Test func namesMutedGuestsFromTheBoardOrAsAGuest() async {
        let store = joined()
        try? store.update(for: slug) {
            $0.mute(participantID: "p2")
            $0.mute(participantID: "gone")
        }
        let service = FakeService()
        service.leaderboardResults = [.success([
            LeaderboardEntry(participantID: "p2", nickname: "Sara", totalPoints: 3, momentCount: 2, rank: 1),
        ])]
        let model = LeaderboardModel(slug: slug, participantID: "p1", service: service, store: store)
        model.reloadMuted()
        await model.loadIfStale()
        #expect(model.mutedGuests.map(\.id) == ["p2", "gone"])
        #expect(model.mutedGuests.map(MutedGuestsView.name) == ["Sara", "A guest"])
    }

    @Test func theReportDialogOffersAMuteOnlyWhenAllowed() {
        let sara = photo("s1", by: "p2")
        #expect(ReportQuestion(sara, canMute: true).muteParticipantID == "p2")
        #expect(ReportQuestion(sara, canMute: true).uploaderName == "P2")
        #expect(ReportQuestion(sara, canMute: false).muteParticipantID == nil)
        #expect(ReportQuestion(photo("old", by: nil), canMute: true).muteParticipantID == nil)
        let unnamed = Moment(
            id: "u", eventID: "e1", uploaderName: "", uploaderID: "p9", pointsAwarded: 1, createdAt: .distantPast,
            seq: 1, changeSeq: 1, media: Media(kind: .image, url: "https://moments-hq.com/media/u.jpg")
        )
        #expect(ReportQuestion(unnamed, canMute: true).uploaderName == "A guest")
    }
}
