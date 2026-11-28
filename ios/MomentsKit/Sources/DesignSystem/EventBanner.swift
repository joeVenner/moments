import SwiftUI

/// The colours of an event's banner when it has no cover photo: the web's
/// `EVENT_BANNER_PRESETS` (`src/client/lib/eventBanners.tsx`). Change a
/// value here and there together.
public struct EventBannerPalette: Sendable, Hashable {
    /// Diagonal gradient, top-left to bottom-right.
    public let stops: [RGB]
    /// The soft light in the corner.
    public let glow: RGB

    public static let wedding = EventBannerPalette(
        stops: [RGB(0x2B, 0x2B, 0x2B), RGB(0x3A, 0x3A, 0x3A), RGB(0x23, 0x23, 0x23)], glow: RGB(0xE8, 0xE0, 0xD4)
    )
    public static let birthday = EventBannerPalette(
        stops: [RGB(0x2A, 0x1A, 0x16), RGB(0x1F, 0x17, 0x14), RGB(0x17, 0x10, 0x10)], glow: Palette.accent
    )
    public static let graduation = EventBannerPalette(
        stops: [RGB(0x2B, 0x24, 0x17), RGB(0x1D, 0x19, 0x12), RGB(0x15, 0x13, 0x0F)], glow: RGB(0xD9, 0xA8, 0x5A)
    )
    public static let corporate = EventBannerPalette(
        stops: [RGB(0x22, 0x2A, 0x2E), RGB(0x1A, 0x1F, 0x22), RGB(0x15, 0x19, 0x1B)], glow: RGB(0x5F, 0xA8, 0xC4)
    )
    public static let party = EventBannerPalette(
        stops: [RGB(0x36, 0x1D, 0x18), RGB(0x24, 0x15, 0x12), RGB(0x17, 0x10, 0x0F)], glow: RGB(0xE5, 0x8A, 0x67)
    )
    /// Custom types and events with none.
    public static let other = EventBannerPalette(
        stops: [Palette.surface, RGB(0x1F, 0x1F, 0x1F), Palette.background], glow: Palette.accent
    )

    /// The palette for a stored event type ("Wedding", "party", …), ignoring
    /// case and outer spaces; `other` for anything else.
    public static func forType(_ type: String) -> EventBannerPalette {
        switch type.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "wedding": wedding
        case "birthday": birthday
        case "graduation": graduation
        case "corporate": corporate
        case "party": party
        default: other
        }
    }
}

/// The banner drawn for an event without a cover photo: its type's gradient
/// with two soft lights. Still (nothing to gate on Reduce Motion).
public struct EventBannerScene: View {
    let palette: EventBannerPalette

    public init(type: String) {
        palette = .forType(type)
    }

    public var body: some View {
        GeometryReader { geometry in
            let side = max(geometry.size.width, geometry.size.height)
            ZStack {
                LinearGradient(colors: palette.stops.map(\.color), startPoint: .topLeading, endPoint: .bottomTrailing)
                RadialGradient(
                    colors: [palette.glow.color.opacity(0.28), palette.glow.color.opacity(0)],
                    center: UnitPoint(x: 0.82, y: 0.2), startRadius: 0, endRadius: side * 0.55
                )
                RadialGradient(
                    colors: [palette.glow.color.opacity(0.14), palette.glow.color.opacity(0)],
                    center: UnitPoint(x: 0.15, y: 0.85), startRadius: 0, endRadius: side * 0.45
                )
            }
        }
        .accessibilityHidden(true)
    }
}
