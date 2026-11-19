import Foundation
import Testing
@testable import FeatureGuest

@Suite struct VideoDurationTextTests {
    private let english = Locale(identifier: "en_US")

    private func text(_ milliseconds: Int?) -> String? {
        MomentThumbnail.durationText(milliseconds, locale: english)
    }

    @Test func showsWholeMinutesAndSecondsThenHours() {
        #expect(text(42_000) == "0:42")
        #expect(text(65_400) == "1:05")
        #expect(text(3_909_000) == "1:05:09")
    }

    @Test func dropsPartSecondsLikeAPlayer() {
        #expect(text(59_600) == "0:59")
        #expect(text(3_599_600) == "59:59")
        #expect(text(400) == "0:01")
    }

    @Test func saysNothingWithoutALength() {
        #expect(text(nil) == nil)
        #expect(text(0) == nil)
        #expect(text(-5) == nil)
    }

    @Test func readsTheLengthInWords() {
        #expect(MomentThumbnail.spokenDuration(42_000, locale: english) == "42 seconds")
        #expect(MomentThumbnail.spokenDuration(nil, locale: english) == nil)
    }
}
