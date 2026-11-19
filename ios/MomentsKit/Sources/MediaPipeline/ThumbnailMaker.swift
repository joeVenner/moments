import AVFoundation
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Makes the small JPEG the feed grid shows in place of the full file.
///
/// Always optional: every function returns nil instead of failing, and the
/// upload goes ahead without one. The server only keeps a whole JPEG of at
/// most `maxBytes`, so the result is checked against that here too.
///
/// Only for files the app prepared itself (`PhotoPreparer`/`VideoPreparer`
/// output): the input limits and format checks live there.
enum ThumbnailMaker {
    /// Longest side of a thumbnail (a third of a phone screen at 3x).
    static let maxPixelSize = 400
    /// The server's limit (`MAX_THUMBNAIL_BYTES`).
    static let maxBytes = 200 * 1024
    /// Tried in order until the JPEG fits in `maxBytes`. A 400 px image
    /// is far below 200 KiB at 0.3, so running out is close to impossible.
    static let qualities = [0.75, 0.6, 0.45, 0.3]

    /// A thumbnail of a prepared photo (the upload JPEG: already upright,
    /// in a standard color space and without metadata).
    /// - Returns: the bytes written to `destination`, or nil (nothing
    ///   written) if it couldn't be made or `destination` already exists.
    static func fromPhoto(_ photo: URL, destination: URL) -> Int64? {
        autoreleasepool {
            guard let source = CGImageSourceCreateWithURL(photo as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
                  // The prepared photo is always a JPEG; never reach ImageIO's other parsers.
                  CGImageSourceGetType(source) as String? == UTType.jpeg.identifier,
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                      kCGImageSourceCreateThumbnailFromImageAlways: true,
                      kCGImageSourceCreateThumbnailWithTransform: true,
                      kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
                  ] as CFDictionary)
            else { return nil }
            return write(image, to: destination)
        }
    }

    /// A thumbnail of a prepared video's first frame, upright as it plays.
    /// - Returns: as `fromPhoto`.
    static func fromVideo(_ video: URL, destination: URL) async -> Int64? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: video))
        // Upright, as the video plays.
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: maxPixelSize, height: maxPixelSize)
        guard let frame = try? await generator.image(at: .zero).image else { return nil }
        return autoreleasepool { write(frame, to: destination) }
    }

    /// Redraws `image` (no metadata or source profile survives), encodes it
    /// small enough and writes it; nil, with nothing left behind, if any
    /// step fails.
    static func write(_ image: CGImage, to destination: URL, maxBytes: Int = ThumbnailMaker.maxBytes) -> Int64? {
        guard let clean = try? PhotoPreparer.normalized(image) else { return nil }
        for quality in qualities {
            guard let data = try? PhotoPreparer.encode(clean, quality: quality) else { return nil }
            guard data.count <= maxBytes else { continue }
            guard (try? PhotoPreparer.write(data, to: destination)) != nil else { return nil }
            return Int64(data.count)
        }
        return nil
    }
}
