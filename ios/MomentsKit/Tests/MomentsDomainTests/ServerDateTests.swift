import Foundation
import Testing
@testable import MomentsDomain

@Suite struct ServerDateTests {
    @Test func parsesTheServerFormatAsUTC() throws {
        let date = try #require(ServerDate.parse("2026-11-17 18:30:05"))
        #expect(date.timeIntervalSince1970 == 1_794_940_205)
    }

    @Test func roundTrips() throws {
        let text = "2027-02-28 00:00:59"
        #expect(ServerDate.format(try #require(ServerDate.parse(text))) == text)
    }

    @Test(arguments: [
        "", "2026-11-17", "2026-11-17T18:30:05", "2026-11-17 18:30:05Z", "2026-11-17 18:30",
        "2026-13-01 00:00:00", "2026-02-30 00:00:00", "2026-11-17 24:00:00", "2026-11-17 18:60:00",
        "２０２６-11-17 18:30:05", "-026-11-17 18:30:05", "2026/11/17 18:30:05",
        "0000-01-01 00:00:00", "2026-11-17 18:30:05\n", " 2026-11-17 18:30:05",
    ])
    func rejectsAnythingElse(_ text: String) {
        #expect(ServerDate.parse(text) == nil)
    }

    @Test func parsesTheEpoch() {
        #expect(ServerDate.parse("1970-01-01 00:00:00")?.timeIntervalSince1970 == 0)
    }

    @Test func ignoresDaylightSavingTransitions() throws {
        // 2026-03-29 01:30 does not exist in Europe/Paris; UTC has no gap.
        let date = try #require(ServerDate.parse("2026-03-29 01:30:00"))
        #expect(ServerDate.format(date) == "2026-03-29 01:30:00")
    }

    @Test func acceptsALeapDay() {
        #expect(ServerDate.parse("2028-02-29 12:00:00") != nil)
    }
}
