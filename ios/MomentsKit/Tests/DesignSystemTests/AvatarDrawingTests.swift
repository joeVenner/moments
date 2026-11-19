import CoreGraphics
import Foundation
import ImageIO
import SwiftUI
import Testing
import UniformTypeIdentifiers
@testable import DesignSystem

@Suite struct AvatarPathDataTests {
    @Test func readsEachCommand() throws {
        let path = try #require(AvatarPathData.path("M 0 0 L 10 0 C 10 5 5 10 0 10 Z"))
        let bounds = path.boundingRect
        #expect(bounds.minX == 0 && bounds.minY == 0 && bounds.maxX == 10 && bounds.maxY == 10)
    }

    @Test(arguments: ["", "L 1 1", "M 1", "M 1 x", "Q 1 1 2 2", "M 0 0 C 1 2 3"])
    func refusesWhatTheGeneratorNeverWrites(_ data: String) {
        #expect(AvatarPathData.path(data) == nil)
    }
}

@Suite struct AvatarShapesTests {
    private static let viewBox = CGRect(x: 0, y: 0, width: 200, height: 200)

    private static func check(_ layers: [AvatarLayer], transform: CGAffineTransform, name: String) {
        #expect(!layers.isEmpty, "\(name) has layers")
        for layer in layers {
            #expect(!layer.paths.isEmpty, "\(name) has paths in every layer")
            for shape in layer.paths {
                let path = AvatarPathData.path(shape.data)
                #expect(path != nil, "\(name) path reads")
                guard let bounds = path?.boundingRect.applying(transform) else { continue }
                // On the 200 × 200 face. DiceBear's own art pokes a few points
                // past the edge (the kissHeart heart, the shades), which the
                // circle clips on both apps; a broken arc or transform would
                // land far outside.
                #expect(viewBox.insetBy(dx: -10, dy: -10).contains(bounds), "\(name) stays on the face: \(bounds)")
            }
        }
    }

    @Test func everyEyeReadsAndFits() {
        for eyes in AvatarEyes.allCases {
            Self.check(eyes.layers, transform: AvatarDrawing.eyesTransform, name: "eyes \(eyes)")
            #expect(AvatarDrawing.eyes[eyes]?.flatMap(\.paths).count == eyes.layers.flatMap(\.paths).count)
        }
    }

    @Test func everyMouthReadsAndFits() {
        for mouth in AvatarMouth.allCases {
            Self.check(mouth.layers, transform: AvatarDrawing.mouthTransform, name: "mouth \(mouth)")
            #expect(AvatarDrawing.mouths[mouth]?.flatMap(\.paths).count == mouth.layers.flatMap(\.paths).count)
        }
    }
}

@MainActor
@Suite struct AvatarRenderingTests {
    /// The face drawn square at 200 × 200 pixels, as RGBA bytes.
    private func render(_ parts: AvatarParts) throws -> (pixels: [UInt8], image: CGImage) {
        let view = Canvas { context, size in AvatarDrawing.draw(parts, in: context, side: size.width) }
            .frame(width: 200, height: 200)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        let image = try #require(renderer.cgImage)
        var pixels = [UInt8](repeating: 0, count: 200 * 200 * 4)
        let context = try #require(CGContext(
            data: &pixels, width: 200, height: 200, bitsPerComponent: 8, bytesPerRow: 800,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(image, in: CGRect(x: 0, y: 0, width: 200, height: 200))
        return (pixels, image)
    }

    private func pixel(_ pixels: [UInt8], x: Int, y: Int) -> (Int, Int, Int) {
        // CGContext rows start at the bottom.
        let offset = ((199 - y) * 200 + x) * 4
        return (Int(pixels[offset]), Int(pixels[offset + 1]), Int(pixels[offset + 2]))
    }

    @Test func drawsTheBackgroundAndTheFace() throws {
        for background in AvatarBackground.allCases {
            let parts = AvatarParts(eyes: .cute, mouth: .wideSmile, background: background)
            let (pixels, _) = try render(parts)
            let corner = pixel(pixels, x: 2, y: 2)
            #expect(abs(corner.0 - (background.hex >> 16 & 0xff)) <= 2 && abs(corner.1 - (background.hex >> 8 & 0xff)) <= 2
                && abs(corner.2 - (background.hex & 0xff)) <= 2, "\(background) background")
            // The eyes (dark) sit in the upper middle, the mouth below.
            let darkInEyes = (60..<110).contains { y in (40..<160).contains { x in pixel(pixels, x: x, y: y).0 < 60 } }
            let darkInMouth = (110..<170).contains { y in (40..<160).contains { x in pixel(pixels, x: x, y: y).0 < 60 } }
            #expect(darkInEyes && darkInMouth, "\(background) face drawn")
        }
    }

    /// One full-size black square as a single layer, drawn on `background`; the center pixel.
    private func centerPixel(of layer: AvatarLayer, on background: Int) throws -> (Int, Int, Int) {
        let prepared = AvatarDrawing.prepare([layer])
        let view = Canvas { context, _ in
            context.fill(Path(CGRect(x: 0, y: 0, width: 200, height: 200)), with: .color(AvatarDrawing.color(background)))
            AvatarDrawing.draw(prepared, in: context, transform: .identity)
        }
        .frame(width: 200, height: 200)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        let image = try #require(renderer.cgImage)
        var pixels = [UInt8](repeating: 0, count: 4)
        let context = try #require(CGContext(
            data: &pixels, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(try #require(image.cropping(to: CGRect(x: 100, y: 100, width: 1, height: 1))), in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return (Int(pixels[0]), Int(pixels[1]), Int(pixels[2]))
    }

    private static let blackSquare = AvatarShapePath("M 0 0 L 200 0 L 200 200 L 0 200 Z", fill: .color(0x000000))

    @Test func appliesLayerOpacityOnce() throws {
        let (red, _, _) = try centerPixel(of: AvatarLayer(opacity: 0.4, paths: [Self.blackSquare]), on: 0xffffff)
        // 60 % of white is 153; opacity applied twice would give 214.
        #expect(abs(red - 153) <= 3, "got \(red)")
    }

    @Test func blendsSoftLight() throws {
        let (red, green, blue) = try centerPixel(of: AvatarLayer(opacity: 0.4, softLight: true, paths: [Self.blackSquare]), on: 0xfcbc34)
        // W3C soft-light of black is the backdrop squared: 252,188,52 → 249,139,11;
        // at 40 % that gives about 251,168,35. Plain black at 40 % would be 151,113,31.
        #expect(abs(red - 251) <= 8 && abs(green - 168) <= 12 && abs(blue - 35) <= 12, "got \(red),\(green),\(blue)")
    }

    /// Set AVATAR_PNG_DIR to look at every part (for checking against the web by eye).
    @Test func writesPreviewsWhenAsked() throws {
        guard let directory = ProcessInfo.processInfo.environment["AVATAR_PNG_DIR"] else { return }
        for (index, eyes) in AvatarEyes.allCases.enumerated() {
            let mouth = AvatarMouth.allCases[index]
            let background = AvatarBackground.allCases[index % AvatarBackground.allCases.count]
            let (_, image) = try render(AvatarParts(eyes: eyes, mouth: mouth, background: background))
            let url = URL(fileURLWithPath: directory).appendingPathComponent("\(eyes)-\(mouth).png")
            let destination = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
            CGImageDestinationAddImage(destination, image, nil)
            #expect(CGImageDestinationFinalize(destination))
        }
    }
}
