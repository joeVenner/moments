import Testing
@testable import MomentsDomain

@Suite struct PointsTests {
    @Test(arguments: [("video/mp4", 3), ("VIDEO/QuickTime", 3), ("image/jpeg", 1), ("", 1), ("application/video", 1)])
    func pointsByContentType(_ contentType: String, _ expected: Int) {
        #expect(Points.forContentType(contentType) == expected)
    }

    @Test func milestonesMatchTheWeb() {
        #expect(Points.milestones == [5, 10, 25, 50, 100])
    }

    @Test func celebratesOnlyTheHighestMilestoneCrossed() {
        #expect(Points.highestMilestoneCrossed(from: 4, to: 5) == 5)
        #expect(Points.highestMilestoneCrossed(from: 3, to: 27) == 25)
        #expect(Points.highestMilestoneCrossed(from: 5, to: 9) == nil)
        #expect(Points.highestMilestoneCrossed(from: 100, to: 300) == nil)
        #expect(Points.highestMilestoneCrossed(from: 0, to: 0) == nil)
        #expect(Points.highestMilestoneCrossed(from: 1, to: 2, milestones: [2]) == 2)
    }

    @Test func progressRunsFromTheLastMilestoneToTheNext() throws {
        #expect(Points.progress(toward: 0) == .init(target: 5, remaining: 5, fraction: 0))
        #expect(Points.progress(toward: 5) == .init(target: 10, remaining: 5, fraction: 0))
        let between = try #require(Points.progress(toward: 40))
        #expect(between.target == 50 && between.remaining == 10)
        #expect(abs(between.fraction - 0.6) < 1e-9)
        #expect(Points.progress(toward: -3)?.target == 5)
    }

    @Test func noProgressOncePastTheLastMilestone() {
        #expect(Points.progress(toward: 100) == nil)
        #expect(Points.progress(toward: 250) == nil)
        #expect(Points.progress(toward: 3, milestones: []) == nil)
        #expect(Points.progress(toward: 1, milestones: [2]) == .init(target: 2, remaining: 1, fraction: 0.5))
    }
}
