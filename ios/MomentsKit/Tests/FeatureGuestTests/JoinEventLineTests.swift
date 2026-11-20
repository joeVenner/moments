import Foundation
import MomentsDomain
import Testing
@testable import FeatureGuest

@Suite struct JoinEventLineTests {
    private let startsAt = Date(timeIntervalSince1970: 1_781_000_000)

    private func event(type: String, startsAt: Date? = nil) -> Event {
        Event(id: "e", slug: "party", title: "Party", type: type, createdAt: .distantPast, startsAt: startsAt)
    }

    @Test func aKnownTypeIsTranslatedWhateverItsCase() {
        #expect(JoinEventLine(event(type: "  wedding ")).kind == .preset(.wedding))
    }

    @Test func aCustomTypeIsShownAsWritten() {
        #expect(JoinEventLine(event(type: " Bar mitzvah ")).kind == .custom("Bar mitzvah"))
    }

    @Test func aBlankTypeIsLeftOut() {
        #expect(JoinEventLine(event(type: "   ", startsAt: startsAt)).kind == .none)
    }

    @Test func keepsTheStartDateWhenThereIsOne() {
        #expect(JoinEventLine(event(type: "Party", startsAt: startsAt)).startsAt == startsAt)
        #expect(JoinEventLine(event(type: "Party")).startsAt == nil)
    }
}
