import Testing
@testable import DesignSystem

@Suite struct EventBannerPaletteTests {
    @Test func aKnownTypeGetsItsPaletteWhateverItsCaseOrSpaces() {
        #expect(EventBannerPalette.forType("Wedding") == .wedding)
        #expect(EventBannerPalette.forType("  party ") == .party)
        #expect(EventBannerPalette.forType("CORPORATE") == .corporate)
    }

    @Test func aCustomOrMissingTypeGetsTheNeutralPalette() {
        #expect(EventBannerPalette.forType("Baby shower") == .other)
        #expect(EventBannerPalette.forType("") == .other)
    }

    @Test func titlesStayReadableOnEveryBanner() {
        // The title sits on the darkest stop (under a scrim); AA needs 4.5:1.
        for palette in [EventBannerPalette.wedding, .birthday, .graduation, .corporate, .party, .other] {
            #expect(Palette.text.contrastRatio(against: palette.stops[2]) >= 4.5)
        }
    }
}
