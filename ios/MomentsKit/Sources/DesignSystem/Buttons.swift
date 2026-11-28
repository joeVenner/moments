import SwiftUI

/// The one filled accent button. The label is bold (WCAG "large" text), which
/// keeps the pressed colour's 4.1:1 contrast within AA.
public struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(MomentsFont.body(.headline).bold())
            .foregroundStyle(MomentsColor.onAccent)
            .frame(maxWidth: .infinity, minHeight: Radius.minimumTapTarget)
            .padding(.horizontal, Spacing.md)
            .background(
                configuration.isPressed ? MomentsColor.accentPressed : MomentsColor.accent,
                in: RoundedRectangle(cornerRadius: Radius.control)
            )
            .opacity(isEnabled ? 1 : 0.5)
    }
}

public extension ButtonStyle where Self == PrimaryButtonStyle {
    static var momentsPrimary: PrimaryButtonStyle { PrimaryButtonStyle() }
}

/// Outlined button for the second action next to a primary one, so a
/// screen keeps a single orange button.
public struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(MomentsFont.body(.headline).bold())
            .foregroundStyle(MomentsColor.text)
            .frame(maxWidth: .infinity, minHeight: Radius.minimumTapTarget)
            .padding(.horizontal, Spacing.md)
            .background(
                configuration.isPressed ? MomentsColor.border : MomentsColor.surface,
                in: RoundedRectangle(cornerRadius: Radius.control)
            )
            .overlay(RoundedRectangle(cornerRadius: Radius.control).stroke(MomentsColor.border))
            .opacity(isEnabled ? 1 : 0.5)
    }
}

public extension ButtonStyle where Self == SecondaryButtonStyle {
    static var momentsSecondary: SecondaryButtonStyle { SecondaryButtonStyle() }
}

/// Text field on a card surface with the border token.
public struct MomentsFieldStyle: ViewModifier {
    public init() {}

    public func body(content: Content) -> some View {
        content
            .font(MomentsFont.body())
            .foregroundStyle(MomentsColor.text)
            .padding(.horizontal, Spacing.sm)
            .frame(minHeight: Radius.minimumTapTarget)
            .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).stroke(MomentsColor.border))
    }
}

public extension View {
    func momentsField() -> some View { modifier(MomentsFieldStyle()) }
}

/// The app's default button: just its label, dimmed while pressed or
/// disabled. The system's borderless style is not used because the "Button
/// Shapes" accessibility setting draws a grey capsule behind it (and
/// underlines its text), which doubles every button that already draws its
/// own shape. Labels without a colour of their own take the tint, as before.
public struct BareButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(.tint)
            .opacity(isEnabled ? (configuration.isPressed ? 0.6 : 1) : 0.5)
            .contentShape(Rectangle())
    }
}

public extension ButtonStyle where Self == BareButtonStyle {
    static var momentsBare: BareButtonStyle { BareButtonStyle() }
}

public extension View {
    /// Makes `BareButtonStyle` the default for every button below (set once
    /// at the app's root). A `Menu` ignores custom styles: give it `.buttonStyle(.plain)`.
    func momentsButtonDefaults() -> some View {
        buttonStyle(.momentsBare)
            .tint(MomentsColor.accent)
    }
}
