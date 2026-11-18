import Foundation
import Testing

/// The app's catalog (Moments/Localizable.xcstrings) also holds the strings of
/// the MomentsKit feature modules: package code looks strings up in
/// Bundle.main, so French has to ship in the app bundle.
@Suite struct LocalizationTests {
    private static let catalogURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "Moments/Localizable.xcstrings")

    /// Resolves like package code does (Bundle.main), but in French.
    private func french(_ resource: LocalizedStringResource) -> String {
        var resource = resource
        resource.locale = Locale(identifier: "fr")
        return String(localized: resource)
    }

    /// As SwiftUI's Text shows it: Markdown applied, so `^[…](inflect: true)`
    /// agrees with the count (plain `String(localized:)` leaves it raw).
    private func frenchText(_ resource: LocalizedStringResource) -> String {
        var resource = resource
        resource.locale = Locale(identifier: "fr")
        return String(AttributedString(localized: resource).characters)
    }

    @Test func everyStringHasATranslatedFrenchWithTheSamePlaceholders() throws {
        let data = try Data(contentsOf: Self.catalogURL)
        let catalog = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: [String: Any]])
        #expect(strings.count > 100)
        var problems: [String] = []
        for (key, entry) in strings {
            let fr = (entry["localizations"] as? [String: Any])?["fr"] as? [String: Any]
            var units: [[String: Any]] = []
            if let unit = fr?["stringUnit"] as? [String: Any] { units.append(unit) }
            if let plural = (fr?["variations"] as? [String: Any])?["plural"] as? [String: [String: Any]] {
                // French needs both forms (0 and 1 are singular).
                if plural["one"] == nil || plural["other"] == nil { problems.append("\(key): plural one/other") }
                units += plural.values.compactMap { $0["stringUnit"] as? [String: Any] }
            }
            if units.isEmpty { problems.append("\(key): no French") }
            for unit in units {
                let value = unit["value"] as? String ?? ""
                if value.isEmpty || unit["state"] as? String != "translated" { problems.append("\(key): not translated") }
                // A missing or extra %lld / %@ garbles or crashes at runtime.
                if Self.placeholders(in: value) != Self.placeholders(in: key) { problems.append("\(key): placeholders") }
            }
        }
        #expect(problems.isEmpty, "\(problems.sorted())")
    }

    private static func placeholders(in text: String) -> [String] {
        text.matches(of: /%(lld|@)/).map { String($0.output.0) }
    }

    @Test func packageStringsResolveInFrench() {
        #expect(french("Your uploads") == "Vos envois")
        // French puts a no-break space before ? ! : and %.
        #expect(french("Leave this event?") == "Quitter cet événement\u{A0}?")
        let name = "Sara"
        #expect(french("Welcome, \(name)!") == "Bienvenue, Sara\u{A0}!")
        let percent = 42
        #expect(french("Uploading \(percent)%") == "Envoi 42\u{A0}%")
    }

    @Test func countsUsePluralForms() {
        let one = 1, three = 3
        #expect(french("\(one) need attention") == "1 demande votre attention")
        #expect(french("\(three) need attention") == "3 demandent votre attention")
        var english = LocalizedStringResource("\(one) need attention")
        english.locale = Locale(identifier: "en")
        #expect(String(localized: english) == "1 needs attention")
    }

    /// Automatic grammar agreement must pluralize the French nouns (and the
    /// adjective), with 0 and 1 singular.
    @Test(arguments: [(0, "0 cœur"), (1, "1 cœur"), (2, "2 cœurs")])
    func heartsAgree(count: Int, expected: String) {
        #expect(frenchText("^[\(count) heart](inflect: true)") == expected)
    }

    @Test(arguments: [(1, "1 nouveau souvenir"), (3, "3 nouveaux souvenirs")])
    func newMomentsAgree(count: Int, expected: String) {
        #expect(frenchText("^[\(count) new moment](inflect: true)") == expected)
    }

    @Test(arguments: [(1, "Partager 1 souvenir"), (4, "Partager 4 souvenirs")])
    func shareButtonAgrees(count: Int, expected: String) {
        #expect(frenchText("Share ^[\(count) moment](inflect: true)") == expected)
    }

    @Test func ranksAgree() {
        let rank = 2, nickname = "Lina", points = 3
        #expect(frenchText("Rank \(rank), \(nickname), ^[\(points) point](inflect: true)") == "Rang 2, Lina, 3 points")
    }
}
