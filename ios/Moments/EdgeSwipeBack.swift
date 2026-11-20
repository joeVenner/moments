import SwiftUI
import UIKit

extension View {
    /// Hides the navigation bar but keeps the swipe from the left edge to
    /// go back, which hiding the bar alone turns off.
    func navigationBarHiddenKeepingSwipeBack() -> some View {
        toolbar(.hidden, for: .navigationBar)
            .background(EdgeSwipeBack().frame(width: 0, height: 0).accessibilityHidden(true))
    }
}

/// Turns the stack's back swipe on again, for any screen with one below it.
private struct EdgeSwipeBack: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> EdgeSwipeBackController { EdgeSwipeBackController() }
    func updateUIViewController(_ controller: EdgeSwipeBackController, context: Context) {}
}

final class EdgeSwipeBackController: UIViewController, UIGestureRecognizerDelegate {
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        attach()
    }

    /// Re-taken on every appearance: the screen showing last owns the swipe.
    func attach() {
        guard let swipe = navigationController?.interactivePopGestureRecognizer else { return }
        swipe.delegate = self
        swipe.isEnabled = true
    }

    /// Only with somewhere to go back to, and not mid-push or mid-pop: on the
    /// root screen a swipe would leave the stack waiting for a pop that
    /// never comes.
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let stack = navigationController, stack.transitionCoordinator == nil else { return false }
        return stack.viewControllers.count > 1
    }
}
