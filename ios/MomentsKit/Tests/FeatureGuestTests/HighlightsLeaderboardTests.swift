import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import FeatureGuest

private let slug = EventSlug("party")!

private func moment(_ id: String, seq: Int, reactions: Int = 0) -> Moment {
    Moment(
        id: id, eventID: "e1", uploaderName: "Lea", pointsAwarded: 1, createdAt: .distantPast,
        seq: seq, changeSeq: seq, reactionCount: reactions,
        media: Media(kind: .image, url: "https://moments-hq.com/media/\(id).jpg")
    )
}

private func entry(_ id: String, points: Int, rank: Int) -> LeaderboardEntry {
    LeaderboardEntry(participantID: id, nickname: id.uppercased(), totalPoints: points, momentCount: 1, rank: rank)
}

/// A clock tests move by hand.
private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_800_000_000)
    var now: Date { lock.withLock { current } }
    func advance(by seconds: TimeInterval) { lock.withLock { current += seconds } }
}

@Suite @MainActor struct HighlightsModelTests {
    private func makeModel(clock: Clock = Clock()) -> (HighlightsModel, FakeService) {
        let service = FakeService()
        let model = HighlightsModel(
            slug: slug, service: service, store: InMemoryEventCredentialStore(), now: { clock.now }
        )
        return (model, service)
    }

    @Test func loadsInTheServersOrderOnlyWhenStale() async {
        let clock = Clock()
        let (model, service) = makeModel(clock: clock)
        service.highlightsResults = [
            .success([moment("b", seq: 1, reactions: 9), moment("a", seq: 5, reactions: 2)]),
            .success([moment("a", seq: 5, reactions: 12)]),
        ]
        await model.loadIfStale()
        #expect(model.phase == .loaded)
        #expect(model.moments.map(\.id) == ["b", "a"])
        await model.loadIfStale()
        #expect(service.highlightsCalls.count == 1)
        clock.advance(by: ReloadThrottle.freshFor)
        await model.loadIfStale()
        #expect(model.moments.map(\.id) == ["a"])
    }

    @Test func rateLimitsKeepWhatIsShown() async {
        let (model, service) = makeModel()
        service.highlightsResults = [.success([moment("a", seq: 1)]), .failure(MomentsAPIError.rateLimited)]
        await model.loadIfStale()
        await model.refresh()
        #expect(model.phase == .loaded)
        #expect(model.moments.map(\.id) == ["a"])
    }

    @Test func aFirstFailureCanBeRetried() async {
        let (model, service) = makeModel()
        service.highlightsResults = [.failure(MomentsAPIError.transport(.notConnectedToInternet)), .success([])]
        await model.loadIfStale()
        #expect(model.phase == .failed)
        await model.refresh()
        #expect(model.phase == .loaded)
    }

    @Test func lostAccessGoesToTheFeedAndStops() async {
        let (model, service) = makeModel()
        var fatal: [MomentsAPIError] = []
        model.onFatalError = { fatal.append($0 as! MomentsAPIError) }
        service.highlightsResults = [.failure(MomentsAPIError.accessRequired)]
        await model.loadIfStale()
        #expect(fatal == [.accessRequired])
        await model.refresh()
        #expect(service.highlightsCalls.count == 1)
    }

    @Test func heartsOptimisticallyAndTellsTheFeed() async {
        let (model, service) = makeModel()
        service.highlightsResults = [.success([moment("a", seq: 1, reactions: 2)])]
        service.reactionResults = [.success(ReactionState(reacted: true, reactionCount: 6))]
        var settled: [String] = []
        model.onReactionSettled = { id, _ in settled.append(id) }
        await model.loadIfStale()
        let task = model.toggleReaction(onMomentID: "a")
        #expect(model.moments.first?.reactionCount == 3)
        await task?.value
        #expect(model.moments.first?.reactionCount == 6)
        #expect(settled == ["a"])
        model.applyServerReaction(momentID: "a", state: ReactionState(reacted: false, reactionCount: 5))
        #expect(model.moments.first?.hasReacted == false)
    }

    @Test func aGoneMomentLeavesTheList() async {
        let (model, service) = makeModel()
        service.highlightsResults = [.success([moment("a", seq: 1), moment("b", seq: 2)])]
        service.reactionResults = [.failure(MomentsAPIError.momentNotFound)]
        await model.loadIfStale()
        await model.toggleReaction(onMomentID: "a")?.value
        #expect(model.moments.map(\.id) == ["b"])
        #expect(model.reactionFailureCount == 1)
    }
}

@Suite @MainActor struct LeaderboardModelTests {
    private func makeModel(me: String = "p2", clock: Clock = Clock()) -> (LeaderboardModel, FakeService) {
        let service = FakeService()
        let model = LeaderboardModel(
            slug: slug, participantID: me, service: service, store: InMemoryEventCredentialStore(), now: { clock.now }
        )
        return (model, service)
    }

    @Test func splitsThePodiumByPositionAndFindsMe() async {
        let (model, service) = makeModel(me: "p4")
        service.leaderboardResults = [.success([
            entry("p1", points: 9, rank: 1), entry("p2", points: 9, rank: 1), entry("p3", points: 4, rank: 3),
            entry("p4", points: 1, rank: 4),
        ])]
        await model.loadIfStale()
        #expect(model.podium.map(\.participantID) == ["p1", "p2", "p3"])
        #expect(model.others.map(\.participantID) == ["p4"])
        #expect(model.myEntry?.rank == 4)
        #expect(model.podiumCelebrations == 0)
    }

    @Test func celebratesOnlyOnReachingThePodium() async {
        let clock = Clock()
        let (model, service) = makeModel(me: "p2", clock: clock)
        let onPodium = [entry("p1", points: 9, rank: 1), entry("p2", points: 5, rank: 2)]
        let offPodium = [entry("p1", points: 9, rank: 1), entry("a", points: 8, rank: 2), entry("b", points: 7, rank: 3), entry("p2", points: 5, rank: 4)]
        service.leaderboardResults = [.success(onPodium), .success(onPodium), .success(offPodium), .success(onPodium)]
        for expected in [1, 1, 1, 2] {
            await model.refresh()
            #expect(model.podiumCelebrations == expected)
        }
    }

    @Test func keepsEntriesOnFailureAndHandsOffLostAccess() async {
        let (model, service) = makeModel()
        var fatal = 0
        model.onFatalError = { _ in fatal += 1 }
        service.leaderboardResults = [
            .success([entry("p1", points: 1, rank: 1)]), .failure(MomentsAPIError.rateLimited), .failure(MomentsAPIError.eventNotFound),
        ]
        await model.refresh()
        await model.refresh()
        #expect(model.entries.count == 1)
        #expect(model.phase == .loaded)
        await model.refresh()
        #expect(fatal == 1)
    }
}

@Suite struct InitialsAvatarTests {
    @Test(arguments: [("sara", "S"), ("  élodie", "É"), ("👩🏽‍🚀 Ana", "👩🏽‍🚀"), ("", "?"), ("   ", "?")])
    func takesTheFirstWholeCharacter(_ nickname: String, _ expected: String) {
        #expect(InitialsAvatar.initial(of: nickname) == expected)
    }
}

@Suite @MainActor struct HighlightsLoadingTests {
    private func makeModel(clock: Clock = Clock()) -> (HighlightsModel, FakeService) {
        let service = FakeService()
        let model = HighlightsModel(
            slug: slug, service: service, store: InMemoryEventCredentialStore(), now: { clock.now }
        )
        return (model, service)
    }

    @Test func aPullDuringALoadWaitsForIt() async {
        let (model, service) = makeModel()
        let gate = Gate()
        service.beforeHighlights = { await gate.wait() }
        service.highlightsResults = [.success([moment("a", seq: 1)])]
        let appear = Task { await model.loadIfStale() }
        while service.highlightsCalls.isEmpty { await Task.yield() }
        let pull = Task { await model.refresh() }
        for _ in 0..<20 { await Task.yield() }
        #expect(model.isRefreshing)
        await gate.open()
        await pull.value
        #expect(model.phase == .loaded)
        await appear.value
        #expect(service.highlightsCalls.count == 1)
    }

    @Test func cancellationIsNotAFailure() async {
        let (model, service) = makeModel()
        service.highlightsResults = [.failure(CancellationError())]
        await model.loadIfStale()
        #expect(model.phase == .loading)
    }

    @Test func rateLimitsBackOffTabSwitchesButNotPulls() async {
        let clock = Clock()
        let (model, service) = makeModel(clock: clock)
        service.highlightsResults = [.failure(MomentsAPIError.rateLimited), .success([])]
        await model.loadIfStale()
        #expect(model.phase == .failed)
        await model.loadIfStale()
        #expect(service.highlightsCalls.count == 1)
        await model.refresh()
        #expect(model.phase == .loaded)
    }

    @Test func anEndedListNeitherConfirmsNorSyncsALateAnswer() async {
        let (model, service) = makeModel()
        let gate = Gate()
        service.highlightsResults = [.success([moment("a", seq: 1, reactions: 2)])]
        service.reactionResults = [.success(ReactionState(reacted: true, reactionCount: 3))]
        service.beforeReaction = { await gate.wait() }
        service.reactionsIgnoreCancellation = true
        var settled = 0
        model.onReactionSettled = { _, _ in settled += 1 }
        await model.loadIfStale()
        let task = model.toggleReaction(onMomentID: "a")
        while service.reactionCalls.isEmpty { await Task.yield() }
        model.end()
        await gate.open()
        await task?.value
        #expect(settled == 0)
        #expect(model.moments.first?.hasReacted == false)
        #expect(model.reactionFailureCount == 0)
    }
}

@Suite @MainActor struct CrossListHeartTests {
    @Test func aHeartSettledInTheFeedShowsInHighlightsWithoutEchoing() async {
        let service = FakeService()
        let store = InMemoryEventCredentialStore()
        let highlights = HighlightsModel(slug: slug, service: service, store: store)
        service.highlightsResults = [.success([moment("a", seq: 1, reactions: 2)])]
        await highlights.loadIfStale()
        var echoes = 0
        highlights.onReactionSettled = { _, _ in echoes += 1 }
        // What GuestEventView wires from the feed's onReactionSettled.
        highlights.applyServerReaction(momentID: "a", state: ReactionState(reacted: true, reactionCount: 3))
        #expect(highlights.moments.first?.hasReacted == true)
        #expect(highlights.moments.first?.reactionCount == 3)
        #expect(echoes == 0)
        #expect(service.reactionCalls.isEmpty)
    }

    @Test func aHeartInFlightHereIsNotOverwrittenFromElsewhere() async {
        let service = FakeService()
        let gate = Gate()
        let highlights = HighlightsModel(slug: slug, service: service, store: InMemoryEventCredentialStore())
        service.highlightsResults = [.success([moment("a", seq: 1, reactions: 2)])]
        service.reactionResults = [.success(ReactionState(reacted: true, reactionCount: 3))]
        service.beforeReaction = { await gate.wait() }
        await highlights.loadIfStale()
        let task = highlights.toggleReaction(onMomentID: "a")
        while service.reactionCalls.isEmpty { await Task.yield() }
        highlights.applyServerReaction(momentID: "a", state: ReactionState(reacted: false, reactionCount: 2))
        #expect(highlights.moments.first?.hasReacted == true)
        await gate.open()
        await task?.value
        #expect(highlights.moments.first?.reactionCount == 3)
    }
}

@Suite @MainActor struct LeaderboardPodiumTests {
    @Test func aShortBoardHasAShortPodium() async {
        let service = FakeService()
        let model = LeaderboardModel(slug: slug, participantID: "p1", service: service, store: InMemoryEventCredentialStore())
        service.leaderboardResults = [.success([entry("p1", points: 3, rank: 1), entry("p2", points: 3, rank: 1)])]
        await model.loadIfStale()
        #expect(model.podium.map(\.rank) == [1, 1])
        #expect(model.others.isEmpty)
        #expect(model.podiumCelebrations == 1)
    }
}
