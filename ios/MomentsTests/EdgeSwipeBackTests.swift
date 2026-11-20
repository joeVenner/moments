import Testing
import UIKit
@testable import Moments

@Suite @MainActor struct EdgeSwipeBackTests {
    @Test func takesTheStacksBackSwipe() throws {
        let screen = EdgeSwipeBackController()
        let stack = UINavigationController(rootViewController: screen)
        let swipe = try #require(stack.interactivePopGestureRecognizer)
        swipe.isEnabled = false
        screen.attach()
        #expect(swipe.delegate === screen && swipe.isEnabled)
    }

    @Test func swipesBackOnlyWithAScreenBelow() {
        let screen = EdgeSwipeBackController()
        let stack = UINavigationController(rootViewController: screen)
        #expect(!screen.gestureRecognizerShouldBegin(UIScreenEdgePanGestureRecognizer()))
        stack.pushViewController(UIViewController(), animated: false)
        #expect(screen.gestureRecognizerShouldBegin(UIScreenEdgePanGestureRecognizer()))
    }
}
