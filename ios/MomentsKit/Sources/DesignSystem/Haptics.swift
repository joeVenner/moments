import SwiftUI

/// The app's haptic vocabulary, mapped to SwiftUI's `sensoryFeedback`.
/// Views name the moment (`.reaction`), not the vibration, so the feel can be
/// tuned in one place.
public enum HapticEvent: Sendable, CaseIterable {
    /// A heart on a moment (double-tap or button).
    case reaction
    /// A points milestone was crossed.
    case milestone
    /// An upload finished.
    case uploadComplete
    /// Something failed and needs attention.
    case failure

    public var feedback: SensoryFeedback {
        switch self {
        case .reaction: .impact(weight: .light)
        case .milestone: .success
        // Distinct from a milestone: uploads finish often, so keep it subtle.
        case .uploadComplete: .impact(flexibility: .soft, intensity: 0.8)
        case .failure: .error
        }
    }
}

public extension View {
    /// Plays `event`'s haptic each time `trigger` changes.
    func haptic<Trigger: Equatable>(_ event: HapticEvent, trigger: Trigger) -> some View {
        sensoryFeedback(event.feedback, trigger: trigger)
    }
}
