import SwiftUI

/// Text styles. The web uses Fraunces (display) and Inter (body); natively we
/// use the system serif (New York) and San Francisco, which are close in
/// tone, cost no app or App Clip size, and scale with Dynamic Type.
public enum MomentsFont {
    /// Event titles and big headings.
    public static func display(_ style: Font.TextStyle = .largeTitle) -> Font {
        .system(style, design: .serif).weight(.semibold)
    }

    /// Section headings.
    public static func heading(_ style: Font.TextStyle = .title3) -> Font {
        .system(style).weight(.semibold)
    }

    /// Body copy.
    public static func body(_ style: Font.TextStyle = .body) -> Font {
        .system(style)
    }

    /// Small print: counts, timestamps, hints.
    public static func caption(_ style: Font.TextStyle = .footnote) -> Font {
        .system(style)
    }

    /// Points, counts and ranks: fixed-width digits so values don't jitter.
    public static func number(_ style: Font.TextStyle = .body) -> Font {
        .system(style).weight(.semibold).monospacedDigit()
    }
}

/// Spacing scale in points (a 4-pt grid, like the web's Tailwind spacing).
/// Fixed values: wrap in `@ScaledMetric` where a layout must grow with
/// Dynamic Type.
public enum Spacing {
    public static let xxs: CGFloat = 4
    public static let xs: CGFloat = 8
    public static let sm: CGFloat = 12
    public static let md: CGFloat = 16
    public static let lg: CGFloat = 24
    public static let xl: CGFloat = 32
}

/// Corner radii (the web's rounded-lg / rounded-2xl).
public enum Radius {
    /// Minimum tappable size (Apple HIG).
    public static let minimumTapTarget: CGFloat = 44
    public static let control: CGFloat = 8
    public static let card: CGFloat = 16
    public static let sheet: CGFloat = 24
}
