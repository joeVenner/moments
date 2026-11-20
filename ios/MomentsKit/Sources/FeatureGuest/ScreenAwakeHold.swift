import Foundation

/// Keeps the screen on while uploads are moving and the app is in front
/// (where nothing else keeps them going: the App Clip). Calls `setAwake`
/// only when the answer changes, and always lets the screen sleep again on
/// `release()`: a hold left on would drain the battery.
@MainActor
public final class ScreenAwakeHold {
    private let setAwake: (Bool) -> Void
    private var isHolding = false

    /// `setAwake` sets `UIApplication.shared.isIdleTimerDisabled`.
    public init(setAwake: @escaping (Bool) -> Void) {
        self.setAwake = setAwake
    }

    public func update(activeCount: Int, isInFront: Bool) {
        apply(activeCount > 0 && isInFront)
    }

    public func release() {
        apply(false)
    }

    private func apply(_ hold: Bool) {
        guard hold != isHolding else { return }
        isHolding = hold
        setAwake(hold)
    }
}
