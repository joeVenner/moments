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
}
