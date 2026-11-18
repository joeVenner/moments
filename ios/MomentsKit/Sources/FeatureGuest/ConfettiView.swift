#if os(iOS)
import DesignSystem
import SwiftUI
import UIKit

/// Confetti from the top edge, once per change of `bursts` (never on first
/// show). Callers gate it on `Motion.shouldCelebrate`.
struct ConfettiView: UIViewRepresentable {
    let bursts: Int

    private static let duration: TimeInterval = 1.2

    func makeUIView(context: Context) -> EmitterView {
        EmitterView()
    }

    func updateUIView(_ view: EmitterView, context: Context) {
        guard bursts != view.lastBurst else { return }
        let isFirstUpdate = view.lastBurst == nil
        view.lastBurst = bursts
        if !isFirstUpdate { view.burst(for: Self.duration) }
    }

    final class EmitterView: UIView {
        var lastBurst: Int?
        private let emitter = CAEmitterLayer()
        /// Stops the current burst; replaced (not stacked) by a new burst so
        /// an earlier timer can't cut a later burst short.
        private var stopWork: DispatchWorkItem?

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            emitter.emitterShape = .line
            emitter.birthRate = 0
            emitter.emitterCells = Palette.confetti.map(Self.cell)
            layer.addSublayer(emitter)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { nil }

        override func layoutSubviews() {
            super.layoutSubviews()
            emitter.emitterPosition = CGPoint(x: bounds.midX, y: -8)
            emitter.emitterSize = CGSize(width: bounds.width, height: 1)
        }

        func burst(for duration: TimeInterval) {
            stopWork?.cancel()
            emitter.beginTime = emitter.convertTime(CACurrentMediaTime(), from: nil)
            emitter.birthRate = 1
            let work = DispatchWorkItem { [weak self] in self?.emitter.birthRate = 0 }
            stopWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + duration, execute: work)
        }

        override func removeFromSuperview() {
            stopWork?.cancel()
            emitter.birthRate = 0
            super.removeFromSuperview()
        }

        private static func cell(_ color: RGB) -> CAEmitterCell {
            let cell = CAEmitterCell()
            cell.birthRate = 18
            cell.lifetime = 5
            cell.velocity = 180
            cell.velocityRange = 80
            cell.emissionLongitude = .pi
            cell.emissionRange = .pi / 5
            cell.spin = 3
            cell.spinRange = 4
            cell.scale = 0.6
            cell.scaleRange = 0.3
            cell.yAcceleration = 160
            cell.color = UIColor(red: CGFloat(color.red) / 255, green: CGFloat(color.green) / 255, blue: CGFloat(color.blue) / 255, alpha: 1).cgColor
            cell.contents = Self.confettiImage
            return cell
        }

        private static let confettiImage: CGImage? = {
            let renderer = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 12))
            return renderer.image { context in
                UIColor.white.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 8, height: 12))
            }.cgImage
        }()
    }
}
#endif
