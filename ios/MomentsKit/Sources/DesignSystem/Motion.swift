import SwiftUI

/// Motion rules, mirroring `src/client/lib/motion.ts`: every animation and
/// celebration is skipped when the user asks for reduced motion.
public enum Motion {
    /// The animation to use, or nil (change instantly) under Reduce Motion.
    /// Use it for `withAnimation` too: `withAnimation(Motion.animation(.default, reduceMotion: reduceMotion))`.
    public static func animation(_ animation: Animation, reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : animation
    }

    /// Whether to play a celebration (confetti, milestone burst).
    public static func shouldCelebrate(reduceMotion: Bool) -> Bool {
        !reduceMotion
    }

    /// Standard transition for small state changes.
    public static let standard = Animation.snappy(duration: 0.25)
}

/// `.animation` that honours Reduce Motion: use instead of `.animation(_:value:)`.
private struct MotionAwareAnimation<Value: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let animation: Animation
    let value: Value

    func body(content: Content) -> some View {
        content.animation(Motion.animation(animation, reduceMotion: reduceMotion), value: value)
    }
}

public extension View {
    /// Animates changes to `value`, or applies them instantly under Reduce Motion.
    func momentsAnimation<Value: Equatable>(_ animation: Animation = Motion.standard, value: Value) -> some View {
        modifier(MotionAwareAnimation(animation: animation, value: value))
    }
}
