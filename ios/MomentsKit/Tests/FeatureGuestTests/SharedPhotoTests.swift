import CoreGraphics
import Foundation
import ImageIO
import MomentsDomain
import Testing
@testable import FeatureGuest

@Suite struct SharedPhotoTests {
    private func image(width: Int, height: Int) throws -> CGImage {
        let context = try #require(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.setFillColor(red: 0.85, green: 0.47, blue: 0.34, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return try #require(context.makeImage())
    }

    @Test func encodesAJPEGOfTheSameSizeWithNoLocation() throws {
        let data = try SharedPhoto.jpegData(from: try image(width: 40, height: 30))
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        #expect(CGImageSourceGetType(source) as String? == "public.jpeg")
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        #expect(properties[kCGImagePropertyPixelWidth] as? Int == 40)
        #expect(properties[kCGImagePropertyPixelHeight] as? Int == 30)
        #expect(properties[kCGImagePropertyGPSDictionary] == nil)
    }

    /// A real camera JPEG with a location, through the loader and the share.
    @Test func aPhotoWithALocationIsSharedWithoutIt() async throws {
        let original = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(original, "public.jpeg" as CFString, 1, nil))
        let gps: [CFString: Any] = [kCGImagePropertyGPSLatitude: 33.57, kCGImagePropertyGPSLatitudeRef: "N",
                                    kCGImagePropertyGPSLongitude: 7.59, kCGImagePropertyGPSLongitudeRef: "W"]
        CGImageDestinationAddImage(destination, try image(width: 64, height: 48), [kCGImagePropertyGPSDictionary: gps] as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        let source = try #require(CGImageSourceCreateWithData(original, nil))
        let before = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        #expect(before[kCGImagePropertyGPSDictionary] != nil)

        let bytes = original as Data
        let loader = ThumbnailLoader(fetch: { _ in bytes })
        let photo = try #require(SharedPhoto(media: Media(kind: .image, url: "https://moments-hq.com/media/a.jpg"), images: loader))
        let shared = try SharedPhoto.jpegData(from: try await photo.load())
        let after = try #require(CGImageSourceCreateWithData(shared as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(after, 0, nil) as? [CFString: Any])
        #expect(properties[kCGImagePropertyGPSDictionary] == nil)
        #expect(properties[kCGImagePropertyPixelWidth] as? Int == 64)
    }

    @Test func aFailedLoadFailsTheShare() async throws {
        struct Offline: Error {}
        let loader = ThumbnailLoader(fetch: { _ in throw Offline() })
        let photo = try #require(SharedPhoto(media: Media(kind: .image, url: "https://moments-hq.com/media/a.jpg"), images: loader))
        await #expect(throws: (any Error).self) { try await photo.load() }
    }

    @Test func onlyPhotosCanBeShared() {
        let loader = ThumbnailLoader(fetch: { _ in Data() })
        let photo = Media(kind: .image, url: "https://moments-hq.com/media/a.jpg")
        let video = Media(kind: .video, url: "https://moments-hq.com/media/a.mp4", posterURL: "https://moments-hq.com/media/p.jpg")
        #expect(SharedPhoto(media: photo, images: loader) != nil)
        #expect(SharedPhoto(media: video, images: loader) == nil)
    }
}
