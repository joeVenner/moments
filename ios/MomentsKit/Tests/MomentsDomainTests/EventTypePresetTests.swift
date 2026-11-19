import Testing
@testable import MomentsDomain

@Suite struct EventTypePresetTests {
    @Test func storedValuesMatchTheWebTemplates() {
        #expect(EventTypePreset.allCases.map(\.storedValue) == ["Wedding", "Birthday", "Graduation", "Corporate", "Party"])
    }

    @Test func matchesAStoredTypeWhateverItsCaseOrSpacing() {
        #expect(EventTypePreset.matching("Wedding") == .wedding)
        #expect(EventTypePreset.matching("  party ") == .party)
        #expect(EventTypePreset.matching("BIRTHDAY") == .birthday)
    }

    @Test func aCustomOrEmptyTypeMatchesNothing() {
        #expect(EventTypePreset.matching("Baby shower") == nil)
        #expect(EventTypePreset.matching("") == nil)
        #expect(EventTypePreset.matching("Weddings") == nil)
    }

    @Test func onlyAWrittenTypeIsCustom() {
        #expect(EventTypePreset.isCustom("Baby shower"))
        #expect(!EventTypePreset.isCustom("wedding"))
        #expect(!EventTypePreset.isCustom(""))
        #expect(!EventTypePreset.isCustom("   "))
    }
}
