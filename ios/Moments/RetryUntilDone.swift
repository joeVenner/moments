import Foundation

/// Runs `attempt` now and, while it fails, again each time `trigger` is
/// posted, then stops listening. Used for launch work that can fail while
/// the phone is locked (a background launch) and should finish once it's
/// unlocked, not only at the next launch.
@MainActor
final class RetryUntilDone {
    private var observer: (any NSObjectProtocol)?
    private let center: NotificationCenter

    /// `trigger` must be posted on the main thread.
    init(on trigger: Notification.Name, center: NotificationCenter = .default, _ attempt: @escaping @MainActor () -> Bool) {
        self.center = center
        // Listening before the first attempt, so an unlock right after it
        // isn't missed.
        observer = center.addObserver(forName: trigger, object: nil, queue: nil) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.observer != nil, attempt() else { return }
                self.stop()
            }
        }
        if attempt() { stop() }
    }

    var isWaiting: Bool { observer != nil }

    private func stop() {
        if let observer { center.removeObserver(observer) }
        observer = nil
    }
}
