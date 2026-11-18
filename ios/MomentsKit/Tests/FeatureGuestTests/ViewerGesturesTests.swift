import CoreGraphics
import Testing
@testable import FeatureGuest

@Suite struct ViewerGesturesTests {
    @Test func zoomStaysInRange() {
        #expect(ViewerGestures.clampedScale(0.4) == 1)
        #expect(ViewerGestures.clampedScale(2) == 2)
        #expect(ViewerGestures.clampedScale(9) == 4)
    }

    @Test func doubleTapToggles() {
        #expect(ViewerGestures.scaleAfterDoubleTap(from: 1) == 2.5)
        #expect(ViewerGestures.scaleAfterDoubleTap(from: 3) == 1)
    }

    @Test func swipeDownDismissesOnlyWhenNotZoomed() {
        let far = CGSize(width: 10, height: 150)
        #expect(ViewerGestures.shouldDismiss(translation: far, predictedEnd: far, scale: 1))
        #expect(!ViewerGestures.shouldDismiss(translation: far, predictedEnd: far, scale: 2))
        let flick = CGSize(width: 0, height: 40)
        #expect(ViewerGestures.shouldDismiss(translation: flick, predictedEnd: CGSize(width: 0, height: 300), scale: 1))
        #expect(!ViewerGestures.shouldDismiss(translation: flick, predictedEnd: flick, scale: 1))
        // Sideways (paging) and upward drags never close it.
        #expect(!ViewerGestures.shouldDismiss(translation: CGSize(width: 200, height: 130), predictedEnd: .zero, scale: 1))
        #expect(!ViewerGestures.shouldDismiss(translation: CGSize(width: 0, height: -200), predictedEnd: .zero, scale: 1))
    }

    @Test func panStaysWithinTheZoomedPhoto() {
        let size = CGSize(width: 400, height: 800)
        #expect(ViewerGestures.clampedPan(CGSize(width: 900, height: -900), scale: 2, in: size) == CGSize(width: 200, height: -400))
        #expect(ViewerGestures.clampedPan(CGSize(width: 50, height: 10), scale: 2, in: size) == CGSize(width: 50, height: 10))
        #expect(ViewerGestures.clampedPan(CGSize(width: 50, height: 10), scale: 1, in: size) == .zero)
    }

    @Test func backgroundFadesWithTheDrag() {
        #expect(ViewerGestures.backgroundOpacity(forDrag: 0) == 1)
        #expect(ViewerGestures.backgroundOpacity(forDrag: -50) == 1)
        #expect(ViewerGestures.backgroundOpacity(forDrag: 1000) == 0.3)
    }
}
