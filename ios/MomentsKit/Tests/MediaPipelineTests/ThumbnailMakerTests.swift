import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import MediaPipeline

/// A noisy image (hard to compress), so the size limit matters.
private func noisyJPEG(_ width: Int, _ height: Int, to url: URL) throws {
    let context = try #require(CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ))
    var generator = SystemRandomNumberGenerator()
    for y in stride(from: 0, to: height, by: 2) {
        for x in stride(from: 0, to: width, by: 2) {
            context.setFillColor(
                red: .random(in: 0...1, using: &generator), green: .random(in: 0...1, using: &generator),
                blue: .random(in: 0...1, using: &generator), alpha: 1
            )
            context.fill(CGRect(x: x, y: y, width: 2, height: 2))
        }
    }
    let image = try #require(context.makeImage())
    let destination = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 1.0] as CFDictionary)
    try #require(CGImageDestinationFinalize(destination))
}

/// No camera metadata in the file, whatever the source carried.
private func expectNoMetadata(_ url: URL) throws {
    let data = try Data(contentsOf: url)
    let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
    let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
    let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
    let tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]
    #expect(properties[kCGImagePropertyGPSDictionary] == nil)
    #expect(exif[kCGImagePropertyExifDateTimeOriginal] == nil && exif[kCGImagePropertyExifUserComment] == nil)
    #expect(tiff[kCGImagePropertyTIFFMake] == nil && tiff[kCGImagePropertyTIFFModel] == nil)
    for marker in ["SENTINEL", "<x:xmpmeta", "Test Phone"] {
        #expect(data.range(of: Data(marker.utf8)) == nil, "found \(marker)")
    }
}

struct ThumbnailMakerTests {
    @Test func dropsEveryBitOfMetadataEvenFromATaggedSource() throws {
        let folder = try VideoFolder()
        let photo = folder.url.appending(path: "tagged.jpg")
        let context = try #require(CGContext(
            data: nil, width: 800, height: 600, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        context.setFillColor(red: 0.2, green: 0.5, blue: 0.7, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 800, height: 600))
        let destination = try #require(CGImageDestinationCreateWithURL(photo as CFURL, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try #require(context.makeImage()), [
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 48.8584, kCGImagePropertyGPSLatitudeRef: "N"],
            kCGImagePropertyExifDictionary: [
                kCGImagePropertyExifDateTimeOriginal: "2026:11:18 12:00:00", kCGImagePropertyExifUserComment: "SENTINEL-EXIF",
            ],
            kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFMake: "SENTINEL-MAKE", kCGImagePropertyTIFFModel: "Test Phone"],
        ] as CFDictionary)
        try #require(CGImageDestinationFinalize(destination))
        let thumb = folder.url.appending(path: "thumb.jpg")
        #expect(ThumbnailMaker.fromPhoto(photo, destination: thumb) != nil)
        try expectNoMetadata(thumb)
    }

    @Test func refusesAnythingButAJPEG() throws {
        let folder = try VideoFolder()
        let png = folder.url.appending(path: "photo.png")
        let context = try #require(CGContext(
            data: nil, width: 50, height: 50, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        let destination = try #require(CGImageDestinationCreateWithURL(png as CFURL, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try #require(context.makeImage()), nil)
        try #require(CGImageDestinationFinalize(destination))
        #expect(ThumbnailMaker.fromPhoto(png, destination: folder.url.appending(path: "thumb.jpg")) == nil)
    }

    @Test func makesASmallWholeJPEGWithinTheServerLimit() throws {
        let folder = try VideoFolder()
        let photo = folder.url.appending(path: "photo.jpg")
        try noisyJPEG(1200, 800, to: photo)
        let thumb = folder.url.appending(path: "thumb.jpg")
        let byteCount = try #require(ThumbnailMaker.fromPhoto(photo, destination: thumb))
        let data = try Data(contentsOf: thumb)
        #expect(Int64(data.count) == byteCount)
        #expect(data.count <= ThumbnailMaker.maxBytes)
        // What the server checks: starts FF D8 FF, ends FF D9.
        #expect(Array(data.prefix(3)) == [0xFF, 0xD8, 0xFF] && Array(data.suffix(2)) == [0xFF, 0xD9])
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        #expect(properties[kCGImagePropertyPixelWidth] as? Int == 400)
        #expect(properties[kCGImagePropertyPixelHeight] as? Int == 267)
        // ImageIO adds pixel-size EXIF to any JPEG; nothing from a camera.
        let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
        #expect(properties[kCGImagePropertyGPSDictionary] == nil && exif[kCGImagePropertyExifDateTimeOriginal] == nil)
    }

    @Test func neverEnlargesASmallPhoto() throws {
        let folder = try VideoFolder()
        let photo = folder.url.appending(path: "photo.jpg")
        try noisyJPEG(120, 80, to: photo)
        let thumb = folder.url.appending(path: "thumb.jpg")
        #expect(ThumbnailMaker.fromPhoto(photo, destination: thumb) != nil)
        let source = try #require(CGImageSourceCreateWithURL(thumb as CFURL, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        #expect(properties[kCGImagePropertyPixelWidth] as? Int == 120)
    }

    @Test func givesNothingForAnUnreadableFile() async throws {
        let folder = try VideoFolder()
        let junk = folder.url.appending(path: "junk")
        try Data("not media".utf8).write(to: junk)
        #expect(ThumbnailMaker.fromPhoto(junk, destination: folder.url.appending(path: "a.jpg")) == nil)
        #expect(await ThumbnailMaker.fromVideo(junk, destination: folder.url.appending(path: "b.jpg")) == nil)
        #expect(folder.files == ["junk"])
    }

    @Test func refusesToReplaceAnExistingFile() throws {
        let folder = try VideoFolder()
        let photo = folder.url.appending(path: "photo.jpg")
        try noisyJPEG(100, 100, to: photo)
        let thumb = folder.url.appending(path: "thumb.jpg")
        try Data("old".utf8).write(to: thumb)
        #expect(ThumbnailMaker.fromPhoto(photo, destination: thumb) == nil)
        #expect(try Data(contentsOf: thumb) == Data("old".utf8))
    }

    @Test func lowersTheQualityUntilItFitsAndGivesUpBeyond() throws {
        let folder = try VideoFolder()
        let photo = folder.url.appending(path: "photo.jpg")
        try noisyJPEG(400, 400, to: photo)
        let source = try #require(CGImageSourceCreateWithURL(photo as CFURL, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let best = try #require(ThumbnailMaker.write(image, to: folder.url.appending(path: "a.jpg")))
        // A limit just under the first quality's size forces a lower one.
        let lower = try #require(ThumbnailMaker.write(image, to: folder.url.appending(path: "b.jpg"), maxBytes: Int(best) - 1))
        #expect(lower < best)
        #expect(ThumbnailMaker.write(image, to: folder.url.appending(path: "c.jpg"), maxBytes: 100) == nil)
        #expect(!FileManager.default.fileExists(atPath: folder.url.appending(path: "c.jpg").path()))
    }

    @Test func showsAPortraitVideoUpright() async throws {
        let folder = try VideoFolder()
        // Recorded landscape, played portrait (as phones store it).
        let video = try await fixture(640, 360, transform: CGAffineTransform(rotationAngle: .pi / 2), in: folder)
        let thumb = folder.url.appending(path: "thumb.jpg")
        let byteCount = try #require(await ThumbnailMaker.fromVideo(video, destination: thumb))
        let data = try Data(contentsOf: thumb)
        #expect(Int64(data.count) == byteCount && Array(data.suffix(2)) == [0xFF, 0xD9])
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        #expect(properties[kCGImagePropertyPixelWidth] as? Int == 225)
        #expect(properties[kCGImagePropertyPixelHeight] as? Int == 400)
        try expectNoMetadata(thumb)
    }
}
