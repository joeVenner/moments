import CoreGraphics

/// The viewer's gesture rules, kept pure so they can be tested.
enum ViewerGestures {
    static let minimumScale: CGFloat = 1
    static let maximumScale: CGFloat = 4
    static let doubleTapScale: CGFloat = 2.5
    /// How far down (points) a drag must travel to close the viewer.
    static let dismissDistance: CGFloat = 120
    /// A quick flick closes it sooner (points per second, predicted end).
    static let dismissPredictedDistance: CGFloat = 260

    static func clampedScale(_ scale: CGFloat) -> CGFloat {
        min(max(scale, minimumScale), maximumScale)
    }

    /// Double tap toggles between fit and a fixed zoom.
    static func scaleAfterDoubleTap(from scale: CGFloat) -> CGFloat {
        scale > minimumScale ? minimumScale : doubleTapScale
    }

    /// Swipe down to close: only when not zoomed, mostly vertical, and far
    /// or fast enough.
    static func shouldDismiss(translation: CGSize, predictedEnd: CGSize, scale: CGFloat) -> Bool {
        guard scale <= minimumScale, translation.height > 0, abs(translation.height) > abs(translation.width) else {
            return false
        }
        return translation.height > dismissDistance || predictedEnd.height > dismissPredictedDistance
    }

    /// Keeps a zoomed photo covering the screen: the offset may move at most
    /// half the overflow each way.
    static func clampedPan(_ pan: CGSize, scale: CGFloat, in size: CGSize) -> CGSize {
        let maxX = max(0, (size.width * scale - size.width) / 2)
        let maxY = max(0, (size.height * scale - size.height) / 2)
        return CGSize(width: min(max(pan.width, -maxX), maxX), height: min(max(pan.height, -maxY), maxY))
    }

    /// The page fades as it is dragged down, so the feed shows through.
    static func backgroundOpacity(forDrag height: CGFloat) -> Double {
        Double(max(0.3, 1 - max(0, height) / 400))
    }
}
