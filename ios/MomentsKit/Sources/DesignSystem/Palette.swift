import SwiftUI

/// An sRGB colour as 8-bit channels, so tokens can be checked (contrast) in
/// plain tests and turned into SwiftUI colours in one place.
public struct RGB: Sendable, Hashable {
    public let red: UInt8
    public let green: UInt8
    public let blue: UInt8

    public init(_ red: UInt8, _ green: UInt8, _ blue: UInt8) {
        self.red = red
        self.green = green
        self.blue = blue
    }

    public var color: Color {
        Color(.sRGB, red: Double(red) / 255, green: Double(green) / 255, blue: Double(blue) / 255)
    }

    /// WCAG 2.x relative luminance.
    public var relativeLuminance: Double {
        func linear(_ channel: UInt8) -> Double {
            let value = Double(channel) / 255
            return value <= 0.040_45 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }

    /// WCAG contrast ratio against another colour (1...21).
    public func contrastRatio(against other: RGB) -> Double {
        let (light, dark) = relativeLuminance > other.relativeLuminance
            ? (relativeLuminance, other.relativeLuminance)
            : (other.relativeLuminance, relativeLuminance)
        return (light + 0.05) / (dark + 0.05)
    }
}

/// The web's dark theme tokens (`src/client/index.css` `@theme`). Layered
/// charcoal, one orange accent used sparingly; never pure black or white.
/// Change a value here and in index.css together.
public enum Palette {
    /// Page background (`--color-bg`).
    public static let background = RGB(0x1A, 0x1A, 0x1A)
    /// Cards and raised surfaces (`--color-bg-alt`).
    public static let surface = RGB(0x26, 0x26, 0x26)
    /// Hairline borders (`--color-border`).
    public static let border = RGB(0x38, 0x38, 0x38)
    /// Primary text (`--color-text`).
    public static let text = RGB(0xED, 0xED, 0xED)
    /// Secondary text (`--color-text-muted`).
    public static let textMuted = RGB(0xA1, 0xA1, 0xA1)
    /// The only accent (`--color-accent`). Fine as text on background/surface.
    public static let accent = RGB(0xD9, 0x77, 0x57)
    /// Accent pressed state (`--color-accent-dark`). A fill only: as text it
    /// fails AA on the dark surfaces.
    public static let accentPressed = RGB(0xC1, 0x5F, 0x3C)
    /// Labels and icons on an accent fill. Light text on the orange fails AA
    /// (about 2.7:1), so filled buttons use the page charcoal (5.6:1; 4.1:1 on
    /// the pressed fill, so button labels must be semibold 17 pt+).
    public static let onAccent = background

    /// Celebration colours, same as the web's `BRAND_CONFETTI_COLORS`.
    public static let confetti: [RGB] = [accent, accentPressed, text]
}

/// SwiftUI colours for views: `.foregroundStyle(MomentsColor.textMuted)`.
public enum MomentsColor {
    public static let background = Palette.background.color
    public static let surface = Palette.surface.color
    public static let border = Palette.border.color
    public static let text = Palette.text.color
    public static let textMuted = Palette.textMuted.color
    public static let accent = Palette.accent.color
    public static let accentPressed = Palette.accentPressed.color
    public static let onAccent = Palette.onAccent.color
}
