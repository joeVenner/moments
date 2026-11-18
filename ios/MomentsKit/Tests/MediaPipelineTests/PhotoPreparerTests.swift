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

    var files: [String] { (try? FileManager.default.contentsOfDirectory(atPath: url.path())) ?? [] }
}

/// A `width`×`height` image, left half red and right half blue (so a
/// rotation shows up), in `space`, written as `type` with the given
/// metadata (and XMP, if given).
private func fixture(
    _ width: Int, _ height: Int, type: UTType, properties: [CFString: Any] = [:], xmp: CGImageMetadata? = nil,
    space: CFString = CGColorSpace.sRGB, alpha: CGFloat = 1, in folder: Folder
) throws -> URL {
    let context = try #require(CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: space)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ))
    context.setFillColor(red: 1, green: 0, blue: 0, alpha: alpha)
    context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height))
    context.setFillColor(red: 0, green: 0, blue: 1, alpha: alpha)
    context.fill(CGRect(x: width / 2, y: 0, width: width - width / 2, height: height))
    let image = try #require(context.makeImage())
    let url = folder.url.appending(path: "source-\(UUID().uuidString).\(type.preferredFilenameExtension ?? "img")")
    let destination = try #require(CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil))
    if let xmp {
        CGImageDestinationAddImageAndMetadata(destination, image, xmp, properties as CFDictionary)
    } else {
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    }
    try #require(CGImageDestinationFinalize(destination))
    return url
}

private var gps: [CFString: Any] {
    [
        kCGImagePropertyGPSLatitude: 48.8584, kCGImagePropertyGPSLatitudeRef: "N",
        kCGImagePropertyGPSLongitude: 2.2945, kCGImagePropertyGPSLongitudeRef: "E",
    ]
}

/// Distinct marker strings, one per metadata field, so a leak names itself.
private let sentinels = [
    "exif": "SENTINEL-EXIF-COMMENT", "serial": "SENTINEL-BODY-SERIAL", "make": "SENTINEL-TIFF-MAKE",
    "artist": "SENTINEL-TIFF-ARTIST", "software": "SENTINEL-TIFF-SOFTWARE", "iptc": "SENTINEL-IPTC-COPYRIGHT",
    "caption": "SENTINEL-IPTC-CAPTION", "xmp": "SENTINEL-XMP-CREATOR",
]

/// Every kind of metadata a phone or editor might write, each carrying a
/// sentinel.
private var everyKindOfMetadata: [CFString: Any] {
    [
        kCGImagePropertyOrientation: 6,
        kCGImagePropertyGPSDictionary: gps,
        kCGImagePropertyExifDictionary: [
            kCGImagePropertyExifDateTimeOriginal: "2026:11:18 12:00:00",
            kCGImagePropertyExifUserComment: sentinels["exif"]!,
            kCGImagePropertyExifBodySerialNumber: sentinels["serial"]!,
        ],
        kCGImagePropertyTIFFDictionary: [
            kCGImagePropertyTIFFMake: sentinels["make"]!, kCGImagePropertyTIFFModel: "Test Phone",
            kCGImagePropertyTIFFArtist: sentinels["artist"]!, kCGImagePropertyTIFFSoftware: sentinels["software"]!,
        ],
        kCGImagePropertyIPTCDictionary: [
            kCGImagePropertyIPTCCopyrightNotice: sentinels["iptc"]!, kCGImagePropertyIPTCCaptionAbstract: sentinels["caption"]!,
        ],
    ]
}

private func xmpWithSentinel() throws -> CGImageMetadata {
    let metadata = CGImageMetadataCreateMutable()
    try #require(CGImageMetadataSetValueWithPath(metadata, nil, "dc:creator" as CFString, sentinels["xmp"]! as CFString))
    return metadata
}

private func properties(of url: URL) throws -> [CFString: Any] {
    let source = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
    return try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
}

private func type(of url: URL) -> UTType? {
    CGImageSourceCreateWithURL(url as CFURL, nil).flatMap(CGImageSourceGetType).flatMap { UTType($0 as String) }
}

/// The color at fractions (`x`, `y`) of the image, `y` from the top.
private func color(of url: URL, atX x: Double, y: Double = 0.5) throws -> (red: UInt8, green: UInt8, blue: UInt8) {
    let source = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
    let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
    var pixel = [UInt8](repeating: 0, count: 4)
    let context = try #require(CGContext(
        data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ))
    let px = Double(image.width) * x, py = Double(image.height) * (1 - y)
    context.draw(image, in: CGRect(x: -px, y: -py, width: Double(image.width), height: Double(image.height)))
    return (pixel[0], pixel[1], pixel[2])
}

/// The JPEG's segments up to the image data, as (marker, payload).
private func segments(of data: Data) throws -> [(marker: UInt8, payload: Data)] {
    let bytes = [UInt8](data)
    try #require(bytes.count > 4 && bytes[0] == 0xFF && bytes[1] == 0xD8)
    var found: [(UInt8, Data)] = []
    var index = 2
    while index + 4 <= bytes.count {
        try #require(bytes[index] == 0xFF)
        let marker = bytes[index + 1]
        let length = Int(bytes[index + 2]) << 8 | Int(bytes[index + 3])
        found.append((marker, Data(bytes[(index + 4) ..< min(index + 2 + length, bytes.count)])))
        // Image data follows the start of scan; stop there.
        if marker == 0xDA { break }
        index += 2 + length
    }
    return found
}

private func heicEncoderWorks() -> Bool {
    let data = NSMutableData()
    guard let context = CGContext(
        data: nil, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ), let image = context.makeImage(),
        let destination = CGImageDestinationCreateWithData(data, UTType.heic.identifier as CFString, 1, nil)
    else { return false }
    CGImageDestinationAddImage(destination, image, nil)
    return CGImageDestinationFinalize(destination)
}

struct PhotoPreparerTests {
    @Test func scalesDownAndTurnsUpright() throws {
        let folder = try Folder()
        // Orientation 6: stored landscape, shown rotated 90° clockwise.
        let source = try fixture(4000, 3000, type: .jpeg, properties: [kCGImagePropertyOrientation: 6], in: folder)
        let output = folder.url.appending(path: "photo.jpg")
        let prepared = try PhotoPreparer.prepare(source: source, destination: output)
        #expect(abs(prepared.width - 1920) <= 1 && prepared.height == 2560)
        let attributes = try FileManager.default.attributesOfItem(atPath: output.path())
        #expect(attributes[.size] as? Int64 == prepared.byteCount)
        #expect(type(of: output) == .jpeg)
        #expect((try properties(of: output)[kCGImagePropertyOrientation] as? Int ?? 1) == 1)
        #expect(folder.files.sorted() == ["photo.jpg", source.lastPathComponent].sorted())
    }

    @Test func dropsEveryKindOfMetadata() throws {
        let folder = try Folder()
        let source = try fixture(1200, 900, type: .jpeg, properties: everyKindOfMetadata, xmp: xmpWithSentinel(), in: folder)
        // Positive control: the fixture really carries each field.
        let original = try Data(contentsOf: source)
        for sentinel in sentinels.values {
            #expect(original.range(of: Data(sentinel.utf8)) != nil, "fixture lacks \(sentinel)")
        }
        #expect(try properties(of: source)[kCGImagePropertyGPSDictionary] != nil)

        let output = folder.url.appending(path: "photo.jpg")
        _ = try PhotoPreparer.prepare(source: source, destination: output)
        let bytes = try Data(contentsOf: output)
        for sentinel in Array(sentinels.values) + ["Test Phone", "2026:11:18", "http://ns.adobe.com/xap"] {
            #expect(bytes.range(of: Data(sentinel.utf8)) == nil, "\(sentinel) survived")
        }
        let written = try properties(of: output)
        for key in [kCGImagePropertyGPSDictionary, kCGImagePropertyIPTCDictionary, kCGImagePropertyMakerAppleDictionary] {
            #expect(written[key] == nil, "\(key) survived")
        }
        // Only the segments the encoder itself writes: JFIF, a small Exif
        // block of its own, the standard profile, Photoshop resolution
        // info; no comments or other application segments.
        for (marker, payload) in try segments(of: bytes) {
            switch marker {
            case 0xE0: #expect(payload.starts(with: Data("JFIF".utf8)))
            case 0xE1: #expect(payload.starts(with: Data("Exif".utf8)) && payload.count < 512)
            case 0xE2: #expect(payload.starts(with: Data("ICC_PROFILE".utf8)))
            case 0xED: #expect(payload.starts(with: Data("Photoshop 3.0".utf8)) && payload.count < 256)
            case 0xDB, 0xC4, 0xC0, 0xC2, 0xDD, 0xDA: break
            default: Issue.record("unexpected JPEG segment 0x\(String(marker, radix: 16))")
            }
        }
    }

    @Test func embedsOnlyAStandardColorProfile() throws {
        let folder = try Folder()
        // Any other profile is replaced: wide-gamut ones (Adobe RGB) by
        // Display P3, others by sRGB. Told apart by their description text.
        let cases = [
            (CGColorSpace.adobeRGB1998, "Display P3"), (CGColorSpace.displayP3, "Display P3"), (CGColorSpace.sRGB, "sRGB"),
            (CGColorSpace.genericRGBLinear, "sRGB"),
        ]
        for (space, expected) in cases {
            let source = try fixture(64, 64, type: .png, space: space, in: folder)
            let output = folder.url.appending(path: "\(UUID().uuidString).jpg")
            _ = try PhotoPreparer.prepare(source: source, destination: output)
            let image = try #require(CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(output as CFURL, nil)!, 0, nil))
            let profile = try #require(image.colorSpace?.copyICCData() as Data?)
            let text = String(decoding: profile.filter { $0 != 0 }, as: UTF8.self)
            #expect(text.contains(expected) && !text.contains("Adobe"), "\(space)")
        }
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

    @Test func putsTransparencyOnWhite() throws {
        let folder = try Folder()
        let source = try fixture(100, 100, type: .png, alpha: 0, in: folder)
        let output = folder.url.appending(path: "photo.jpg")
        _ = try PhotoPreparer.prepare(source: source, destination: output)
        let pixel = try color(of: output, atX: 0.5)
        #expect(pixel.red > 240 && pixel.green > 240 && pixel.blue > 240)
    }

    @Test func neverEnlargesASmallPhoto() throws {
        let folder = try Folder()
        let source = try fixture(640, 480, type: .png, in: folder)
        let prepared = try PhotoPreparer.prepare(source: source, destination: folder.url.appending(path: "photo.jpg"))
        #expect(prepared.width == 640 && prepared.height == 480)
        let tiny = try fixture(1, 1, type: .png, in: folder)
        let one = try PhotoPreparer.prepare(source: tiny, destination: folder.url.appending(path: "tiny.jpg"))
        #expect(one.width == 1 && one.height == 1)
    }

    @Test(.enabled(if: heicEncoderWorks(), "HEIC encoding unavailable here"))
    func convertsHEICToJPEGWithoutItsMetadata() throws {
        let folder = try Folder()
        let source = try fixture(3000, 2000, type: .heic, properties: everyKindOfMetadata, in: folder)
        #expect(try properties(of: source)[kCGImagePropertyGPSDictionary] != nil)
        let output = folder.url.appending(path: "photo.jpg")
        let prepared = try PhotoPreparer.prepare(source: source, destination: output)
        #expect(abs(prepared.width - 1707) <= 1 && prepared.height == 2560)
        #expect(type(of: output) == .jpeg)
        let bytes = try Data(contentsOf: output)
        for sentinel in sentinels.values where sentinel != sentinels["xmp"] {
            #expect(bytes.range(of: Data(sentinel.utf8)) == nil, "\(sentinel) survived")
        }
        #expect(try properties(of: output)[kCGImagePropertyGPSDictionary] == nil)
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
        // A format outside the allowlist, though ImageIO reads it.
        let tiff = try fixture(100, 100, type: .tiff, in: folder)
        #expect(throws: PhotoPreparer.Problem.unreadable) {
            try PhotoPreparer.prepare(source: tiff, destination: folder.url.appending(path: "c.jpg"))
        }
        for name in ["a.jpg", "b.jpg", "c.jpg"] { #expect(!folder.files.contains(name)) }
    }

    @Test func refusesATruncatedPhoto() throws {
        let folder = try Folder()
        let source = try fixture(800, 600, type: .jpeg, in: folder)
        let whole = try Data(contentsOf: source)
        let cut = folder.url.appending(path: "cut.jpg")
        try whole.prefix(whole.count / 2).write(to: cut)
        #expect(throws: PhotoPreparer.Problem.unreadable) {
            try PhotoPreparer.prepare(source: cut, destination: folder.url.appending(path: "a.jpg"))
        }
        #expect(!folder.files.contains("a.jpg"))
    }

    @Test func acceptsDataAfterTheImage() throws {
        let folder = try Folder()
        // A Motion Photo appends a video after the JPEG; others pad.
        let source = try fixture(800, 600, type: .jpeg, properties: everyKindOfMetadata, in: folder)
        var motion = try Data(contentsOf: source)
        motion += Data([0, 0, 0, 24]) + Data("ftypmp42".utf8) + Data((0 ..< 50_000).map { UInt8(truncatingIfNeeded: $0 &* 31) })
        let motionURL = folder.url.appending(path: "motion.jpg")
        try motion.write(to: motionURL)
        _ = try PhotoPreparer.prepare(source: motionURL, destination: folder.url.appending(path: "a.jpg"))
        var padded = try Data(contentsOf: source)
        padded += Data(repeating: 0, count: 10_000)
        let paddedURL = folder.url.appending(path: "padded.jpg")
        try padded.write(to: paddedURL)
        _ = try PhotoPreparer.prepare(source: paddedURL, destination: folder.url.appending(path: "b.jpg"))
    }

    @Test func removesLeftoversOfInterruptedWrites() throws {
        let folder = try Folder()
        try Data("x".utf8).write(to: folder.url.appending(path: ".\(UUID().uuidString).preparing"))
        try Data("keep".utf8).write(to: folder.url.appending(path: "photo.jpg"))
        PhotoPreparer.removeLeftovers(in: folder.url)
        #expect(folder.files == ["photo.jpg"])
    }

    @Test func refusesTooManyPixelsOrBytes() throws {
        let folder = try Folder()
        let png = try fixture(400, 300, type: .png, in: folder)
        let jpeg = try fixture(400, 300, type: .jpeg, in: folder)
        // Full-decode formats have the lower limit.
        let limits = PhotoPreparer.Limits(subsampledPixels: 1_000_000, heicPixels: 100_000, fullDecodePixels: 100_000)
        #expect(throws: PhotoPreparer.Problem.tooLarge) {
            try PhotoPreparer.prepare(source: png, destination: folder.url.appending(path: "a.jpg"), limits: limits)
        }
        _ = try PhotoPreparer.prepare(source: jpeg, destination: folder.url.appending(path: "b.jpg"), limits: limits)
        #expect(throws: PhotoPreparer.Problem.tooLarge) {
            try PhotoPreparer.prepare(source: jpeg, destination: folder.url.appending(path: "c.jpg"), limits: .init(sourceBytes: 100))
        }
    }

    @Test func neverOverwritesTheDestination() throws {
        let folder = try Folder()
        let source = try fixture(100, 100, type: .png, in: folder)
        let output = folder.url.appending(path: "photo.jpg")
        try Data("keep".utf8).write(to: output)
        #expect(throws: PhotoPreparer.Problem.destinationExists) { try PhotoPreparer.prepare(source: source, destination: output) }
        #expect(try Data(contentsOf: output) == Data("keep".utf8))
        // No temporary file left behind.
        #expect(!folder.files.contains { $0.hasSuffix(".preparing") })
    }
}
