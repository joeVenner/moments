import Foundation
import Testing
@testable import MomentsDomain

private func moment(_ id: String, seq: Int, changeSeq: Int? = nil, reactions: Int = 0, hasReacted: Bool = false) -> Moment {
    Moment(
        id: id, eventID: "ev", uploaderName: "Sara", pointsAwarded: 1, createdAt: Date(timeIntervalSince1970: 0),
        seq: seq, changeSeq: changeSeq ?? seq, reactionCount: reactions, hasReacted: hasReacted,
        media: Media(kind: .image, url: "/media/events/ev/moments/\(id).jpg")
    )
}

private func loaded(_ page: [Moment], nextBefore: Int? = nil, cursor: Int = 10) -> FeedState {
    var feed = FeedState()
    feed.replace(withFirstPage: page, nextBefore: nextBefore, cursor: cursor)
    return feed
}

@Suite struct FeedStatePagingTests {
    @Test func startsEmptyWithoutAssumingTheEnd() {
        let feed = FeedState()
        #expect(feed.moments.isEmpty)
        #expect(feed.cursor == nil)
        #expect(feed.canLoadOlder == false)
    }

    @Test func pagesBackwardsNewestFirst() {
        var feed = loaded([moment("c", seq: 3), moment("b", seq: 2)], nextBefore: 2)
        #expect(feed.canLoadOlder)
        feed.appendOlderPage([moment("a", seq: 1)], nextBefore: nil)
        #expect(feed.moments.map(\.id) == ["c", "b", "a"])
        #expect(feed.canLoadOlder == false)
    }

    @Test func nextBeforeOnlyMovesBack() {
        var feed = loaded([moment("c", seq: 30)], nextBefore: 30)
        feed.appendOlderPage([moment("b", seq: 20)], nextBefore: 20)
        // A slow, earlier request for the same range lands late.
        feed.appendOlderPage([moment("c", seq: 30)], nextBefore: 30)
        #expect(feed.nextBefore == 20)
    }

    @Test func ignoresOlderPagesBeforeTheFirstPage() {
        var feed = FeedState()
        feed.appendOlderPage([moment("a", seq: 1)], nextBefore: nil)
        #expect(feed.moments.isEmpty)
    }

    @Test func refreshReplacesEverything() {
        var feed = loaded([moment("b", seq: 2), moment("a", seq: 1)], nextBefore: 1, cursor: 5)
        feed.replace(withFirstPage: [moment("c", seq: 3)], nextBefore: 3, cursor: 9)
        #expect(feed.moments.map(\.id) == ["c"])
        #expect(feed.cursor == 9)
        #expect(feed.nextBefore == 3)
    }

    @Test func ordersDeterministicallyOnTies() {
        let feed = loaded([moment("a", seq: 1), moment("b", seq: 1)])
        #expect(feed.moments.map(\.id) == ["b", "a"])
    }
}

@Suite struct FeedStateSyncTests {
    @Test func appliesChangesInOrder() {
        var feed = loaded([moment("b", seq: 2), moment("a", seq: 1)], cursor: 5)
        let outcome = feed.applyChanges(
            upserts: [moment("c", seq: 3, changeSeq: 6), moment("a", seq: 1, changeSeq: 7, reactions: 2)],
            removed: ["b"], cursor: 7, hasMore: false
        )
        #expect(outcome == .upToDate)
        #expect(feed.moments.map(\.id) == ["c", "a"])
        #expect(feed.moments.last?.reactionCount == 2)
        #expect(feed.cursor == 7)
    }

    @Test func reportsMoreAvailableUntilCaughtUp() {
        var feed = loaded([], cursor: 0)
        #expect(feed.applyChanges(upserts: [moment("a", seq: 1)], removed: [], cursor: 1, hasMore: true) == .moreAvailable)
        #expect(feed.applyChanges(upserts: [moment("b", seq: 2)], removed: [], cursor: 2, hasMore: false) == .upToDate)
        #expect(feed.cursor == 2)
        #expect(feed.applyChanges(upserts: [], removed: [], cursor: 2, hasMore: false) == .upToDate)
    }

    @Test func asksForAReloadWhenTheServerIsBehind() {
        var feed = loaded([moment("a", seq: 1)], cursor: 50)
        #expect(feed.applyChanges(upserts: [], removed: [], cursor: 12, hasMore: false) == .needsReload)
        #expect(feed.cursor == nil)
        // Nothing applies until the first page is replaced.
        #expect(feed.applyChanges(upserts: [moment("b", seq: 2)], removed: [], cursor: 13, hasMore: false) == .needsReload)
        #expect(feed.moments.map(\.id) == ["a"])
    }

    @Test func ignoresChangesBeforeTheFirstPage() {
        var feed = FeedState()
        #expect(feed.applyChanges(upserts: [moment("a", seq: 1)], removed: [], cursor: 3, hasMore: false) == .needsReload)
        #expect(feed.moments.isEmpty)
        #expect(feed.hasLoadedFirstPage == false)
    }

    @Test func refreshForgetsRemovals() {
        var feed = loaded([moment("a", seq: 1)], cursor: 10)
        feed.applyChanges(upserts: [], removed: ["a"], cursor: 11, hasMore: false)
        feed.replace(withFirstPage: [moment("a", seq: 1, changeSeq: 12)], nextBefore: nil, cursor: 12)
        #expect(feed.moments.map(\.id) == ["a"])
    }

    @Test func olderPageRowsReplaceOnlyWithAHigherChangeSeq() {
        var feed = loaded([moment("b", seq: 2), moment("a", seq: 1, changeSeq: 5, reactions: 1)], nextBefore: 1)
        feed.appendOlderPage([moment("a", seq: 1, changeSeq: 6, reactions: 9)], nextBefore: nil)
        #expect(feed.moments.last?.reactionCount == 9)
    }

    @Test func changesRowsWithALowerChangeSeqAreSkipped() {
        var feed = loaded([moment("a", seq: 1, changeSeq: 8, reactions: 2)], cursor: 10)
        feed.applyChanges(upserts: [moment("a", seq: 1, changeSeq: 3, reactions: 0)], removed: [], cursor: 11, hasMore: false)
        #expect(feed.moments.first?.reactionCount == 2)
    }

    @Test func aStalePageCannotResurrectARemovedMoment() {
        var feed = loaded([moment("b", seq: 2)], nextBefore: 2, cursor: 10)
        feed.applyChanges(upserts: [], removed: ["a"], cursor: 11, hasMore: false)
        // The older page was requested before the hide and lands after it.
        feed.appendOlderPage([moment("a", seq: 1)], nextBefore: nil)
        #expect(feed.moments.map(\.id) == ["b"])
    }

    @Test func aReapprovalBringsTheMomentBack() {
        var feed = loaded([moment("a", seq: 1)], cursor: 10)
        feed.applyChanges(upserts: [], removed: ["a"], cursor: 11, hasMore: false)
        feed.applyChanges(upserts: [moment("a", seq: 1, changeSeq: 12)], removed: [], cursor: 12, hasMore: false)
        #expect(feed.moments.map(\.id) == ["a"])
    }

    @Test func olderPagesDoNotOverwriteFresherRows() {
        var feed = loaded([moment("b", seq: 2)], nextBefore: 2, cursor: 10)
        feed.applyChanges(upserts: [moment("a", seq: 1, changeSeq: 11, reactions: 4)], removed: [], cursor: 11, hasMore: false)
        feed.appendOlderPage([moment("a", seq: 1, changeSeq: 1, reactions: 0)], nextBefore: nil)
        #expect(feed.moments.last?.reactionCount == 4)
    }

    @Test func dedupesWithinOneBatch() {
        let feed = loaded([moment("a", seq: 1, changeSeq: 1), moment("a", seq: 1, changeSeq: 2, reactions: 1)])
        #expect(feed.moments.count == 1)
        #expect(feed.moments.first?.reactionCount == 1)
    }
}

@Suite struct FeedStateReactionTests {
    @Test func togglesOptimisticallyOneRequestAtATime() {
        var feed = loaded([moment("a", seq: 1)])
        let accepted1 = feed.setReacted(true, forMomentID: "a")
        #expect(accepted1)
        #expect(feed.moments.first?.reactionCount == 1)
        // Still in flight: a second toggle is refused, not queued.
        let accepted2 = feed.setReacted(false, forMomentID: "a")
        #expect(accepted2 == false)
        let accepted3 = feed.setReacted(true, forMomentID: "missing")
        #expect(accepted3 == false)
        feed.confirmReaction(forMomentID: "a")
        let accepted4 = feed.setReacted(true, forMomentID: "a")
        #expect(accepted4 == false)
        let accepted5 = feed.setReacted(false, forMomentID: "a")
        #expect(accepted5)
        #expect(feed.moments.first?.reactionCount == 0)
        #expect(feed.moments.first?.hasReacted == false)
    }

    @Test func keepsAPendingToggleAgainstServerEchoes() {
        var feed = loaded([moment("a", seq: 1, reactions: 3)], cursor: 10)
        feed.setReacted(true, forMomentID: "a")
        // A row read before the POST landed echoes the old state.
        feed.applyChanges(upserts: [moment("a", seq: 1, changeSeq: 11, reactions: 3)], removed: [], cursor: 11, hasMore: false)
        #expect(feed.moments.first?.hasReacted == true)
        #expect(feed.moments.first?.reactionCount == 4)
        feed.replace(withFirstPage: [moment("a", seq: 1, reactions: 3)], nextBefore: nil, cursor: 12)
        #expect(feed.moments.first?.reactionCount == 4)
    }

    @Test func confirmedTogglesSurviveOneStaleSyncThenTakeServerValues() {
        var feed = loaded([moment("a", seq: 1, reactions: 3)], cursor: 10)
        feed.setReacted(true, forMomentID: "a")
        feed.confirmReaction(forMomentID: "a")
        // Read before the POST landed: must not flicker the heart back.
        feed.applyChanges(upserts: [moment("a", seq: 1, reactions: 3)], removed: [], cursor: 11, hasMore: false)
        #expect(feed.moments.first?.hasReacted == true)
        #expect(feed.moments.first?.reactionCount == 4)
        feed.applyChanges(upserts: [moment("a", seq: 1, reactions: 7, hasReacted: true)], removed: [], cursor: 12, hasMore: false)
        #expect(feed.moments.first?.reactionCount == 7)
        // A later toggle starts fresh from the server's values.
        let accepted6 = feed.setReacted(false, forMomentID: "a")
        #expect(accepted6)
        #expect(feed.moments.first?.reactionCount == 6)
    }

    @Test func confirmedTogglesAlsoSurviveOneStaleRefresh() {
        var feed = loaded([moment("a", seq: 1, reactions: 3)], cursor: 10)
        feed.setReacted(true, forMomentID: "a")
        feed.confirmReaction(forMomentID: "a")
        feed.replace(withFirstPage: [moment("a", seq: 1, reactions: 3)], nextBefore: nil, cursor: 11)
        #expect(feed.moments.first?.reactionCount == 4)
        feed.replace(withFirstPage: [moment("a", seq: 1, reactions: 4, hasReacted: true)], nextBefore: nil, cursor: 12)
        #expect(feed.moments.first?.reactionCount == 4)
    }

    @Test func refreshDropsPendingTogglesForMissingMoments() {
        var feed = loaded([moment("a", seq: 1, reactions: 3)], cursor: 10)
        feed.setReacted(true, forMomentID: "a")
        feed.replace(withFirstPage: [moment("b", seq: 2)], nextBefore: nil, cursor: 11)
        feed.applyChanges(upserts: [moment("a", seq: 1, changeSeq: 12, reactions: 3)], removed: [], cursor: 12, hasMore: false)
        #expect(feed.moments.last?.reactionCount == 3)
        let accepted7 = feed.setReacted(true, forMomentID: "a")
        #expect(accepted7)
    }

    @Test func removalClearsAPendingToggle() {
        var feed = loaded([moment("a", seq: 1, reactions: 3)], cursor: 10)
        feed.setReacted(true, forMomentID: "a")
        feed.applyChanges(upserts: [], removed: ["a"], cursor: 11, hasMore: false)
        feed.applyChanges(upserts: [moment("a", seq: 1, changeSeq: 12, reactions: 5)], removed: [], cursor: 12, hasMore: false)
        #expect(feed.moments.first?.reactionCount == 5)
        feed.applyChanges(upserts: [moment("a", seq: 1, changeSeq: 12, reactions: 6)], removed: [], cursor: 13, hasMore: false)
        #expect(feed.moments.first?.reactionCount == 6)
    }

    @Test func rollsBackToTheLatestServerValues() {
        var feed = loaded([moment("a", seq: 1, reactions: 3)], cursor: 10)
        feed.setReacted(true, forMomentID: "a")
        feed.applyChanges(upserts: [moment("a", seq: 1, reactions: 5)], removed: [], cursor: 11, hasMore: false)
        feed.rollbackReaction(forMomentID: "a")
        #expect(feed.moments.first?.hasReacted == false)
        #expect(feed.moments.first?.reactionCount == 5)
        feed.rollbackReaction(forMomentID: "a")
        #expect(feed.moments.first?.reactionCount == 5)
    }

    @Test func neverCountsBelowZero() {
        var feed = loaded([moment("a", seq: 1, reactions: 0, hasReacted: true)])
        feed.setReacted(false, forMomentID: "a")
        #expect(feed.moments.first?.reactionCount == 0)
    }
}

@Suite struct ModelTests {
    @Test func picksTheBestGridImage() {
        #expect(Media(kind: .image, url: "o", thumbURL: "t").gridImageURL == "t")
        #expect(Media(kind: .video, url: "o", posterURL: "p").gridImageURL == "p")
        #expect(Media(kind: .image, url: "o").gridImageURL == "o")
        #expect(Media(kind: .video, url: "o").gridImageURL == nil)
    }

    @Test func picksTheViewerImage() {
        #expect(Media(kind: .image, url: "o", thumbURL: "t", displayURL: "d").viewerImageURL == "d")
        #expect(Media(kind: .image, url: "o", thumbURL: "t").viewerImageURL == "o")
        #expect(Media(kind: .video, url: "o", thumbURL: "t", posterURL: "p").viewerImageURL == "p")
        #expect(Media(kind: .video, url: "o", thumbURL: "t").viewerImageURL == "t")
        #expect(Media(kind: .video, url: "o").viewerImageURL == nil)
    }

    @Test func picksWhatAPlayerCanOpen() {
        let stream = "https://customer-abc.cloudflarestream.com/uid/iframe"
        #expect(Media(kind: .video, url: stream, hlsURL: "https://customer-abc.cloudflarestream.com/uid/manifest/video.m3u8").playbackURL?.hasSuffix(".m3u8") == true)
        #expect(Media(kind: .video, url: stream).playbackURL == nil)
        #expect(Media(kind: .video, url: "https://iframe.videodelivery.net/uid").playbackURL == nil)
        #expect(Media(kind: .video, url: "https://moments-hq.com/media/events/e/v.mp4?at=1.x").playbackURL == "https://moments-hq.com/media/events/e/v.mp4?at=1.x")
        #expect(Media(kind: .image, url: "https://moments-hq.com/media/a.jpg").playbackURL == nil)
        #expect(Media(kind: .video, url: "/media/v.mp4").playbackURL == nil)
        #expect(Media(kind: .video, url: "file:///etc/v.mp4").playbackURL == nil)
        // A video's display rendition, when one exists, is its best still.
        #expect(Media(kind: .video, url: "o", displayURL: "d", posterURL: "p").viewerImageURL == "d")
    }

    @Test func aspectRatioNeedsBothSides() {
        #expect(Media(kind: .image, url: "o", width: 1600, height: 900).aspectRatio == 1600.0 / 900.0)
        #expect(Media(kind: .image, url: "o", width: 1600, height: 0).aspectRatio == nil)
        #expect(Media(kind: .image, url: "o", width: nil, height: 900).aspectRatio == nil)
    }

    @Test func eventDatesFallBackToExpiresAt() {
        let end = Date(timeIntervalSince1970: 1_000)
        let legacy = Event(id: "e", slug: "e", title: "E", type: "Party", createdAt: .distantPast, expiresAt: end)
        #expect(legacy.effectiveUploadsCloseAt == end)
        #expect(legacy.effectivePurgeAfter == end)
        let split = Event(
            id: "e", slug: "e", title: "E", type: "Party", createdAt: .distantPast,
            expiresAt: end, uploadsCloseAt: .distantPast, purgeAfter: .distantFuture
        )
        #expect(split.effectiveUploadsCloseAt == .distantPast)
        #expect(split.effectivePurgeAfter == .distantFuture)
    }
}
