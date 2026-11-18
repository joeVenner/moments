import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import MediaPipeline

/// A fresh folder per test, removed afterwards.
private final class Folder {
    let url: URL
    init() throws {
        url = FileManager.default.temporaryDirectory.appending(path: "PhotoPreparerTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: url) }
}

/// A `width`×`height` image, left half red and right half blue (so a
/// rotation shows up), written as `type` with the given metadata.
private func fixture(
    _ width: Int, _ height: Int, type: UTType, properties: [CFString: Any] = [:], in folder: Folder
) throws -> URL {
    let context = try #require(CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ))
    context.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height))
    context.setFillColor(red: 0, green: 0, blue: 1, alpha: 1)
    context.fill(CGRect(x: width / 2, y: 0, width: width - width / 2, height: height))
    let image = try #require(context.makeImage())
    let url = folder.url.appending(path: "source-\(UUID().uuidString).\(type.preferredFilenameExtension ?? "img")")
    let destination = try #require(CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    try #require(CGImageDestinationFinalize(destination))
    return url
}

private var gps: [CFString: Any] { [
    kCGImagePropertyGPSLatitude: 48.8584, kCGImagePropertyGPSLatitudeRef: "N",
    kCGImagePropertyGPSLongitude: 2.2945, kCGImagePropertyGPSLongitudeRef: "E",
] }

private func properties(of url: URL) throws -> [CFString: Any] {
    let source = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
    return try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
}

/// The color at fractions (`x`, `y`) of the image, `y` from the top.
private func color(of url: URL, atX x: Double, y: Double = 0.5) throws -> (red: UInt8, blue: UInt8) {
    let source = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
    let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
    var pixel = [UInt8](repeating: 0, count: 4)
    let context = try #require(CGContext(
        data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ))
    let px = Double(image.width) * x, py = Double(image.height) * (1 - y)
    context.draw(image, in: CGRect(x: -px, y: -py, width: Double(image.width), height: Double(image.height)))
    return (pixel[0], pixel[2])
}

struct PhotoPreparerTests {
    @Test func scalesDownTurnsUprightAndDropsAllMetadata() throws {
        let folder = try Folder()
        // Orientation 6: stored landscape, shown rotated 90° clockwise.
        let source = try fixture(4000, 3000, type: .jpeg, properties: [
            kCGImagePropertyOrientation: 6,
            kCGImagePropertyGPSDictionary: gps,
            kCGImagePropertyExifDictionary: [kCGImagePropertyExifDateTimeOriginal: "2026:11:18 12:00:00"],
            kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFModel: "Test Phone"],
        ], in: folder)
        #expect(try properties(of: source)[kCGImagePropertyGPSDictionary] != nil)
        let output = folder.url.appending(path: "photo.jpg")
        let prepared = try PhotoPreparer.prepare(source: source, destination: output)
        #expect(prepared == PreparedPhoto(width: 1920, height: 2560, byteCount: prepared.byteCount))
        let attributes = try FileManager.default.attributesOfItem(atPath: output.path())
        #expect(attributes[.size] as? Int64 == prepared.byteCount)
        let written = try properties(of: output)
        #expect(written[kCGImagePropertyPixelWidth] as? Int == 1920 && written[kCGImagePropertyPixelHeight] as? Int == 2560)
        #expect(written[kCGImagePropertyGPSDictionary] == nil)
        let exif = written[kCGImagePropertyExifDictionary] as? [CFString: Any]
        #expect(exif?[kCGImagePropertyExifDateTimeOriginal] == nil)
        let tiff = written[kCGImagePropertyTIFFDictionary] as? [CFString: Any]
        #expect(tiff?[kCGImagePropertyTIFFModel] == nil)
        #expect((written[kCGImagePropertyOrientation] as? Int ?? 1) == 1)
        let bytes = try Data(contentsOf: output)
        #expect(bytes.range(of: Data("Test Phone".utf8)) == nil)
        #expect(UTType(CGImageSourceGetType(CGImageSourceCreateWithURL(output as CFURL, nil)!)! as String) == .jpeg)
    }

    @Test func keepsColorsInTheirPlace() throws {
        let folder = try Folder()
        let source = try fixture(400, 200, type: .png, in: folder)
        let output = folder.url.appending(path: "photo.jpg")
        _ = try PhotoPreparer.prepare(source: source, destination: output)
        let left = try color(of: output, atX: 0.25), right = try color(of: output, atX: 0.75)
        #expect(left.red > 200 && left.blue < 60)
        #expect(right.blue > 200 && right.red < 60)
    }

    @Test func appliesTheOrientationToThePixels() throws {
        let folder = try Folder()
        // Stored red left, blue right; orientation 6 shows it turned 90°
        // clockwise, so red ends up on top.
        let source = try fixture(400, 200, type: .jpeg, properties: [kCGImagePropertyOrientation: 6], in: folder)
        let output = folder.url.appending(path: "photo.jpg")
        let prepared = try PhotoPreparer.prepare(source: source, destination: output)
        #expect(prepared.width == 200 && prepared.height == 400)
        let top = try color(of: output, atX: 0.5, y: 0.25), bottom = try color(of: output, atX: 0.5, y: 0.75)
        #expect(top.red > 200 && top.blue < 60)
        #expect(bottom.blue > 200 && bottom.red < 60)
    }

    @Test func neverEnlargesASmallPhoto() throws {
        let folder = try Folder()
        let source = try fixture(640, 480, type: .png, in: folder)
        let prepared = try PhotoPreparer.prepare(source: source, destination: folder.url.appending(path: "photo.jpg"))
        #expect(prepared.width == 640 && prepared.height == 480)
    }

    @Test func convertsHEICToJPEG() throws {
        let folder = try Folder()
        let types = CGImageDestinationCopyTypeIdentifiers() as? [String] ?? []
        try #require(types.contains(UTType.heic.identifier), "HEIC encoding unavailable here")
        let source = try fixture(3000, 2000, type: .heic, properties: [kCGImagePropertyGPSDictionary: gps], in: folder)
        let output = folder.url.appending(path: "photo.jpg")
        let prepared = try PhotoPreparer.prepare(source: source, destination: output)
        #expect(prepared.width == 2560 && (1706 ... 1707).contains(prepared.height))
        let written = try properties(of: output)
        #expect(written[kCGImagePropertyGPSDictionary] == nil)
        #expect(UTType(CGImageSourceGetType(CGImageSourceCreateWithURL(output as CFURL, nil)!)! as String) == .jpeg)
    }

    @Test func refusesWhatIsNotAPhoto() throws {
        let folder = try Folder()
        let junk = folder.url.appending(path: "junk.jpg")
        try Data("not an image at all".utf8).write(to: junk)
        #expect(throws: PhotoPreparer.Problem.unreadable) {
            try PhotoPreparer.prepare(source: junk, destination: folder.url.appending(path: "a.jpg"))
        }
        #expect(throws: PhotoPreparer.Problem.unreadable) {
            try PhotoPreparer.prepare(source: folder.url.appending(path: "missing.jpg"), destination: folder.url.appending(path: "b.jpg"))
        }
        #expect(!FileManager.default.fileExists(atPath: folder.url.appending(path: "a.jpg").path()))
    }

    @Test func refusesTooManyPixels() throws {
        let folder = try Folder()
        let source = try fixture(400, 300, type: .png, in: folder)
        #expect(throws: PhotoPreparer.Problem.tooLarge) {
            try PhotoPreparer.prepare(source: source, destination: folder.url.appending(path: "a.jpg"), maxSourcePixels: 100_000)
        }
    }

    @Test func neverOverwritesTheDestination() throws {
        let folder = try Folder()
        let source = try fixture(100, 100, type: .png, in: folder)
        let output = folder.url.appending(path: "photo.jpg")
        try Data("keep".utf8).write(to: output)
        #expect(throws: PhotoPreparer.Problem.destinationExists) { try PhotoPreparer.prepare(source: source, destination: output) }
        #expect(try Data(contentsOf: output) == Data("keep".utf8))
    }
}
