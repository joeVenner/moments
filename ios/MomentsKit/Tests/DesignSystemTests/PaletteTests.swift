import Foundation
import Testing
@testable import DesignSystem

@Suite struct PaletteTests {
    /// Values must match the web's `@theme` block, both ways: a new web colour
    /// token without a native twin fails too.
    @Test func matchesTheWebTokens() throws {
        let css = try String(contentsOf: webThemeURL(), encoding: .utf8)
        let theme = try #require(css.range(of: "@theme {").map { css[$0.upperBound...] })
        let block = try #require(theme.range(of: "\n}").map { theme[..<$0.lowerBound] })
        let pattern = try Regex(#"--color-([a-z-]+):\s*#([0-9a-fA-F]{6})\s*;"#)
        var web: [String: String] = [:]
        for match in block.matches(of: pattern) {
            if let name = match.output[1].substring, let hex = match.output[2].substring {
                web[String(name)] = hex.lowercased()
            }
        }
        let native: [String: RGB] = [
            "bg": Palette.background, "bg-alt": Palette.surface, "border": Palette.border,
            "text": Palette.text, "text-muted": Palette.textMuted, "accent": Palette.accent,
            "accent-dark": Palette.accentPressed,
        ]
        #expect(Set(web.keys) == Set(native.keys))
        for (token, rgb) in native {
            #expect(web[token] == String(format: "%02x%02x%02x", rgb.red, rgb.green, rgb.blue), "--color-\(token)")
        }
    }

    @Test(arguments: [
        ("text on background", Palette.text, Palette.background),
        ("text on surface", Palette.text, Palette.surface),
        ("muted on background", Palette.textMuted, Palette.background),
        ("muted on surface", Palette.textMuted, Palette.surface),
        ("accent on background", Palette.accent, Palette.background),
        ("accent on surface", Palette.accent, Palette.surface),
        ("label on accent", Palette.onAccent, Palette.accent),
    ])
    func meetsWCAGAAForText(_ name: String, _ foreground: RGB, _ background: RGB) {
        #expect(foreground.contrastRatio(against: background) >= 4.5, "\(name)")
    }

    /// Pressed is momentary and button labels are semibold 17 pt+, which WCAG
    /// counts as large text (3:1).
    @Test func pressedButtonLabelsMeetAAForLargeText() {
        #expect(Palette.onAccent.contrastRatio(against: Palette.accentPressed) >= 3)
    }

    @Test func contrastIsSymmetricAndBounded() {
        let black = RGB(0, 0, 0), white = RGB(255, 255, 255)
        #expect(abs(black.contrastRatio(against: white) - 21) < 0.01)
        #expect(white.contrastRatio(against: black) == black.contrastRatio(against: white))
        #expect(Palette.text.contrastRatio(against: Palette.text) == 1)
    }

    @Test func neverUsesPureBlackOrWhite() {
        let all = [Palette.background, Palette.surface, Palette.border, Palette.text,
                   Palette.textMuted, Palette.accent, Palette.accentPressed]
        #expect(!all.contains(RGB(0, 0, 0)))
        #expect(!all.contains(RGB(255, 255, 255)))
    }

    @Test func confettiUsesTheBrandColours() {
        #expect(Palette.confetti == [Palette.accent, Palette.accentPressed, Palette.text])
    }

    private func webThemeURL() -> URL {
        // Tests/DesignSystemTests → repo root/src/client/index.css
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("src/client/index.css")
    }
}

@Suite struct MotionTests {
    @Test func reduceMotionDisablesAnimationAndCelebration() {
        #expect(Motion.animation(.default, reduceMotion: true) == nil)
        #expect(Motion.animation(.default, reduceMotion: false) != nil)
        #expect(Motion.shouldCelebrate(reduceMotion: true) == false)
        #expect(Motion.shouldCelebrate(reduceMotion: false))
    }
}

@Suite struct HapticsTests {
    @Test func eventsFeelDistinct() {
        let feedback = HapticEvent.allCases.map(\.feedback)
        #expect(feedback.count == 4)
        for (index, item) in feedback.enumerated() {
            #expect(!feedback[(index + 1)...].contains(item))
        }
        #expect(HapticEvent.failure.feedback == .error)
    }
}
