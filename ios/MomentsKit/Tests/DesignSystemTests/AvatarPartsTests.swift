import Foundation
import Testing
@testable import DesignSystem

/// Seeds and the parts the web picks for them, generated from
/// `src/client/lib/avatar.ts` by `npm run avatar:fixtures`.
private struct AvatarFixtures: Decodable {
    struct Case: Decodable {
        let seed: String
        let eyes: String
        let mouth: String
        let background: String
    }

    let eyes: [String]
    let mouth: [String]
    let cases: [Case]

    static func load() throws -> AvatarFixtures {
        let url = try #require(Bundle.module.url(forResource: "avatar-seeds", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(AvatarFixtures.self, from: Data(contentsOf: url))
    }
}

@Suite struct AvatarPartsTests {
    @Test func usesTheWebsAllowlistsInItsOrder() throws {
        let fixtures = try AvatarFixtures.load()
        #expect(AvatarEyes.allCases.map(\.rawValue) == fixtures.eyes)
        #expect(AvatarMouth.allCases.map(\.rawValue) == fixtures.mouth)
    }

    @Test func picksTheSameFaceAsTheWeb() throws {
        let fixtures = try AvatarFixtures.load()
        #expect(fixtures.cases.count > 200)
        for fixture in fixtures.cases {
            let parts = AvatarParts(seed: fixture.seed)
            #expect(parts.eyes.rawValue == fixture.eyes, "eyes for \(fixture.seed.prefix(20))")
            #expect(parts.mouth.rawValue == fixture.mouth, "mouth for \(fixture.seed.prefix(20))")
            #expect(parts.background.rawValue == fixture.background, "background for \(fixture.seed.prefix(20))")
        }
    }

    /// Pinned by hand, so regenerating fixtures can't hide a change.
    @Test func knowsSomeFacesByHeart() {
        #expect(AvatarParts(seed: "") == AvatarParts(eyes: .closed, mouth: .shout, background: .purple))
        #expect(AvatarParts(seed: "a") == AvatarParts(eyes: .stars, mouth: .plain, background: .tan))
    }

    @Test func ignoresEverythingAfter1024Characters() {
        let base = String(repeating: "b", count: 1024)
        #expect(AvatarParts(seed: base + "x") == AvatarParts(seed: base))
        #expect(AvatarParts(seed: base + "zz9") == AvatarParts(seed: base))
    }

    @Test(arguments: AvatarBackground.allCases)
    func readsBackgroundColors(_ background: AvatarBackground) {
        #expect(String(format: "#%06x", background.hex) == background.rawValue)
        let rgb = background.rgb
        #expect(Int((rgb.red * 255).rounded()) << 16 | Int((rgb.green * 255).rounded()) << 8 | Int((rgb.blue * 255).rounded()) == background.hex)
    }
}
