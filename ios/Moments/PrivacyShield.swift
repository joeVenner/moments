import DesignSystem
import SwiftUI

extension View {
    /// Covers the screen while the app isn't active, so the app switcher's
    /// snapshot never shows host data or a sign-in form.
    func privacyShielded() -> some View { modifier(PrivacyShield()) }
}

private struct PrivacyShield: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content.overlay {
            if scenePhase != .active {
                MomentsColor.background
                    .ignoresSafeArea()
                    .overlay {
                        Image(systemName: "lock.fill")
                            .font(.largeTitle)
                            .foregroundStyle(MomentsColor.textMuted)
                            .accessibilityHidden(true)
                    }
            }
        }
    }
}
