import SwiftUI

// What one avatar part draws. `AvatarShapes.generated.swift` fills these in
// from DiceBear's SVG (src/client/lib/avatar.shapes.test.ts); this file
// draws them.

/// A top-level piece of a part: one path, or a group drawn as one layer.
struct AvatarLayer: Sendable {
    var opacity: Double = 1
    /// Drawn with soft-light blending, like SVG `mix-blend-mode: soft-light`.
    var softLight = false
    let paths: [AvatarShapePath]
}

struct AvatarShapePath: Sendable {
    /// Absolute path data with only `M`, `L`, `C` and `Z` (src/client/lib/svgPath.ts).
    let data: String
    let fill: AvatarPaint?
    var evenOdd = false
    var stroke: AvatarStroke?
    var opacity: Double = 1

    init(_ data: String, fill: AvatarPaint?, evenOdd: Bool = false, stroke: AvatarStroke? = nil, opacity: Double = 1) {
        self.data = data
        self.fill = fill
        self.evenOdd = evenOdd
        self.stroke = stroke
        self.opacity = opacity
    }
}

enum AvatarPaint: Sendable {
    case color(Int, alpha: Double = 1)
    /// In the part's own coordinates (SVG `gradientUnits="userSpaceOnUse"`).
    case linear(x1: Double, y1: Double, x2: Double, y2: Double, stops: [AvatarStop])
}

struct AvatarStop: Sendable {
    let offset: Double
    let color: Int
    let alpha: Double

    init(_ offset: Double, _ color: Int, alpha: Double) {
        self.offset = offset
        self.color = color
        self.alpha = alpha
    }
}

struct AvatarStroke: Sendable {
    let color: Int
    let width: Double
    let roundCap: Bool
    let roundJoin: Bool
    let miterLimit: Double

    init(_ color: Int, width: Double, roundCap: Bool, roundJoin: Bool, miterLimit: Double) {
        self.color = color
        self.width = width
        self.roundCap = roundCap
        self.roundJoin = roundJoin
        self.miterLimit = miterLimit
    }
}

enum AvatarPathData {
    /// The path for `M`/`L`/`C`/`Z` data; nil if anything else is in it.
    static func path(_ data: String) -> Path? {
        var path = Path()
        var tokens = data.split(separator: " ")[...]
        func numbers(_ count: Int) -> [CGFloat]? {
            guard tokens.count >= count else { return nil }
            let values = tokens.prefix(count).compactMap { Double($0) }
            tokens = tokens.dropFirst(count)
            return values.count == count ? values.map { CGFloat($0) } : nil
        }
        while let command = tokens.popFirst() {
            switch command {
            case "M":
                guard let v = numbers(2) else { return nil }
                path.move(to: CGPoint(x: v[0], y: v[1]))
            case "L":
                guard let v = numbers(2), !path.isEmpty else { return nil }
                path.addLine(to: CGPoint(x: v[0], y: v[1]))
            case "C":
                guard let v = numbers(6), !path.isEmpty else { return nil }
                path.addCurve(
                    to: CGPoint(x: v[4], y: v[5]),
                    control1: CGPoint(x: v[0], y: v[1]),
                    control2: CGPoint(x: v[2], y: v[3])
                )
            case "Z":
                path.closeSubpath()
            default:
                return nil
            }
        }
        return path.isEmpty ? nil : path
    }
}

/// Draws avatar faces; the parsed paths are made once per part.
enum AvatarDrawing {
    /// DiceBear's canvas: a 200 × 200 view box.
    static let side: CGFloat = 200
    /// Where funEmoji places each part (its `<g transform="matrix(…)">`).
    static let mouthTransform = CGAffineTransform(a: 1.5625, b: 0, c: 0, d: 1.5625, tx: 37.5, ty: 110.94)
    static let eyesTransform = CGAffineTransform(a: 1.5625, b: 0, c: 0, d: 1.5625, tx: 31.25, ty: 59.38)

    struct PreparedPath: Sendable {
        let path: Path
        let shape: AvatarShapePath
    }

    struct PreparedLayer: Sendable {
        let layer: AvatarLayer
        let paths: [PreparedPath]
    }

    static let eyes: [AvatarEyes: [PreparedLayer]] = Dictionary(
        uniqueKeysWithValues: AvatarEyes.allCases.map { ($0, prepare($0.layers)) }
    )
    static let mouths: [AvatarMouth: [PreparedLayer]] = Dictionary(
        uniqueKeysWithValues: AvatarMouth.allCases.map { ($0, prepare($0.layers)) }
    )

    static func prepare(_ layers: [AvatarLayer]) -> [PreparedLayer] {
        layers.map { layer in
            PreparedLayer(
                layer: layer,
                paths: layer.paths.compactMap { shape in
                    guard let path = AvatarPathData.path(shape.data) else {
                        // Never with generated data (AvatarDrawingTests reads every part).
                        assertionFailure("unreadable avatar path")
                        return nil
                    }
                    return PreparedPath(path: path, shape: shape)
                }
            )
        }
    }

    /// The whole face, square, filling `side` points (clip it to a circle outside).
    static func draw(_ parts: AvatarParts, in context: GraphicsContext, side: CGFloat) {
        var context = context
        context.scaleBy(x: side / Self.side, y: side / Self.side)
        context.fill(Path(CGRect(x: 0, y: 0, width: Self.side, height: Self.side)), with: .color(color(parts.background.hex)))
        // Mouth first, then eyes: funEmoji's order.
        draw(mouths[parts.mouth] ?? [], in: context, transform: mouthTransform)
        draw(eyes[parts.eyes] ?? [], in: context, transform: eyesTransform)
    }

    /// Draws a part's layers. A layer with its own opacity or blend is drawn
    /// offscreen and composited once (SVG group semantics); the rest draw directly.
    static func draw(_ layers: [PreparedLayer], in context: GraphicsContext, transform: CGAffineTransform) {
        var context = context
        context.concatenate(transform)
        for prepared in layers {
            guard prepared.layer.opacity != 1 || prepared.layer.softLight else {
                drawPaths(prepared.paths, in: context)
                continue
            }
            var layerContext = context
            layerContext.opacity = prepared.layer.opacity
            layerContext.blendMode = prepared.layer.softLight ? .softLight : .normal
            layerContext.drawLayer { inner in drawPaths(prepared.paths, in: inner) }
        }
    }

    private static func drawPaths(_ paths: [PreparedPath], in context: GraphicsContext) {
        for item in paths {
            var pathContext = context
            pathContext.opacity = item.shape.opacity
            if let fill = item.shape.fill {
                pathContext.fill(item.path, with: shading(fill), style: FillStyle(eoFill: item.shape.evenOdd))
            }
            if let stroke = item.shape.stroke {
                pathContext.stroke(
                    item.path,
                    with: .color(color(stroke.color)),
                    style: StrokeStyle(
                        lineWidth: stroke.width,
                        lineCap: stroke.roundCap ? .round : .butt,
                        lineJoin: stroke.roundJoin ? .round : .miter,
                        miterLimit: stroke.miterLimit
                    )
                )
            }
        }
    }

    private static func shading(_ paint: AvatarPaint) -> GraphicsContext.Shading {
        switch paint {
        case let .color(hex, alpha):
            .color(color(hex, alpha: alpha))
        case let .linear(x1, y1, x2, y2, stops):
            .linearGradient(
                Gradient(stops: stops.map { Gradient.Stop(color: color($0.color, alpha: $0.alpha), location: $0.offset) }),
                startPoint: CGPoint(x: x1, y: y1),
                endPoint: CGPoint(x: x2, y: y2)
            )
        }
    }

    static func color(_ hex: Int, alpha: Double = 1) -> Color {
        Color(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255,
            opacity: alpha
        )
    }
}

/// A guest's face from their avatar seed, drawn on device exactly as the
/// web draws it. Decorative: screens name the guest in text.
public struct AvatarView: View {
    private let parts: AvatarParts
    private let size: CGFloat

    public init(seed: String, size: CGFloat) {
        parts = AvatarParts(seed: seed)
        self.size = size
    }

    public var body: some View {
        Canvas { context, canvasSize in
            AvatarDrawing.draw(parts, in: context, side: min(canvasSize.width, canvasSize.height))
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay { Circle().strokeBorder(MomentsColor.textMuted.opacity(0.4), lineWidth: 1) }
        .accessibilityHidden(true)
    }
}
