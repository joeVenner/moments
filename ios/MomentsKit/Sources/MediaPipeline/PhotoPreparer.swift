import Foundation
import ImageIO
import UniformTypeIdentifiers

/// A photo made ready to upload.
public struct PreparedPhoto: Sendable, Equatable {
    /// Always `image/jpeg`: browsers can't all show HEIC.
    public static let contentType = "image/jpeg"

    public let width: Int
    public let height: Int
    /// Size of the written file.
    public let byteCount: Int64

    public init(width: Int, height: Int, byteCount: Int64) {
        self.width = width
        self.height = height
        self.byteCount = byteCount
    }
}

/// Turns a picked photo into the JPEG that is uploaded: at most
/// `maxPixelSize` on its longest side (never enlarged), turned upright,
/// redrawn into plain sRGB or Display P3, and carrying no metadata at all —
/// no location, camera or device details, capture time, or the source's own
/// color profile. Only the pixels are kept.
///
/// Only common photo formats are read (JPEG, HEIC/HEIF, PNG, GIF, WebP):
/// ImageIO's rarer parsers (RAW, TIFF, EXR, …) are where its exploited bugs
/// have been. Animated sources become their primary frame.
///
/// JPEG and HEIC decode already scaled down; other formats decode at full
/// size first, so they get a lower pixel limit. Synchronous and CPU-heavy:
/// call it off the main actor. The caller deletes the source afterwards
/// (it still holds the original metadata).
public enum PhotoPreparer {
    public enum Problem: Error, Equatable, Sendable {
        /// Not a photo in a supported format, damaged, or incomplete.
        case unreadable
        /// More pixels (or bytes) than the limits allow.
        case tooLarge
        /// The JPEG couldn't be encoded or written.
        case writeFailed
        /// Something already exists at the destination.
        case destinationExists
    }

    /// Bounds on what is read.
    public struct Limits: Sendable {
        /// For JPEG and HEIC, which ImageIO subsamples while decoding.
        public var subsampledPixels: Int
        /// For the other formats, which decode at full size (4 bytes each).
        public var fullDecodePixels: Int
        /// Size of the source file.
        public var sourceBytes: Int64

        public init(subsampledPixels: Int = 120_000_000, fullDecodePixels: Int = 50_000_000, sourceBytes: Int64 = 200_000_000) {
            self.subsampledPixels = subsampledPixels
            self.fullDecodePixels = fullDecodePixels
            self.sourceBytes = sourceBytes
        }
    }

    /// Longest side of the uploaded photo.
    public static let maxPixelSize = 2560
    /// JPEG quality of the uploaded photo.
    public static let quality = 0.85

    static let subsampledTypes: [UTType] = [.jpeg, .heic, .heif]
    static let otherTypes: [UTType] = [.png, .gif, .webP]

    /// Reads the photo at `source` and writes the upload JPEG to
    /// `destination`, which must not exist. Nothing is left at
    /// `destination` unless it succeeds. The file is readable after first
    /// unlock, so a background upload can read it while locked.
    public static func prepare(
        source: URL, destination: URL, maxPixelSize: Int = PhotoPreparer.maxPixelSize, limits: Limits = Limits()
    ) throws(Problem) -> PreparedPhoto {
        precondition(maxPixelSize > 0, "maxPixelSize must be positive")
        // Many photos are prepared in a row on pool threads, which don't
        // drain autorelease pools between jobs.
        let result: Result<(Data, Int, Int), Problem> = autoreleasepool {
            do throws(Problem) {
                let image = try normalized(decode(source, maxPixelSize: maxPixelSize, limits: limits))
                return .success((try encode(image), image.width, image.height))
            } catch {
                return .failure(error)
            }
        }
        let (data, width, height) = try result.get()
        try write(data, to: destination)
        return PreparedPhoto(width: width, height: height, byteCount: Int64(data.count))
    }

    /// The primary image of `source`, upright and scaled to fit.
    static func decode(_ source: URL, maxPixelSize: Int, limits: Limits) throws(Problem) -> CGImage {
        let size = (try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init)
        guard let size else { throw .unreadable }
        guard size <= limits.sourceBytes else { throw .tooLarge }
        guard let imageSource = CGImageSourceCreateWithURL(source as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let type = CGImageSourceGetType(imageSource).flatMap({ UTType($0 as String) })
        else { throw .unreadable }
        let pixelLimit: Int
        if subsampledTypes.contains(type) {
            pixelLimit = limits.subsampledPixels
        } else if otherTypes.contains(type) {
            pixelLimit = limits.fullDecodePixels
        } else {
            throw .unreadable
        }
        let index = CGImageSourceGetPrimaryImageIndex(imageSource)
        guard index < CGImageSourceGetCount(imageSource),
              let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, index, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0
        else { throw .unreadable }
        let (area, overflow) = width.multipliedReportingOverflow(by: height)
        guard !overflow, area <= pixelLimit else { throw .tooLarge }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            // Applies the EXIF orientation, so the pixels are upright.
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: min(maxPixelSize, max(width, height)),
            kCGImageSourceShouldCacheImmediately: true,
        ]
        // A truncated file still decodes (the missing part gray) and
        // ImageIO may call it complete, so JPEG and PNG must also end
        // where their format says.
        guard hasCompleteEnding(source, type: type),
              let image = CGImageSourceCreateThumbnailAtIndex(imageSource, index, options as CFDictionary),
              CGImageSourceGetStatusAtIndex(imageSource, index) == .statusComplete
        else { throw .unreadable }
        return image
    }

    /// JPEG: the last non-zero bytes are the end-of-image marker. PNG: the
    /// file ends with the IEND chunk. Other formats rely on the decoder.
    static func hasCompleteEnding(_ source: URL, type: UTType) -> Bool {
        guard type == .jpeg || type == .png else { return true }
        guard let handle = try? FileHandle(forReadingFrom: source) else { return false }
        defer { try? handle.close() }
        guard let end = try? handle.seekToEnd() else { return false }
        try? handle.seek(toOffset: end - min(end, 4096))
        guard let tail = try? handle.readToEnd() else { return false }
        if type == .png {
            return tail.suffix(12) == Data([0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82])
        }
        // Some writers pad after the marker with zeros.
        let trimmed = tail.reversed().drop { $0 == 0 }
        return Array(trimmed.prefix(2)) == [0xD9, 0xFF]
    }

    /// The image redrawn as opaque 8-bit pixels in a standard color space:
    /// Display P3 when the source is wide gamut, sRGB otherwise. The
    /// source's own profile (which can carry arbitrary text) never reaches
    /// the output, HDR is brought to SDR, and transparency lands on white.
    static func normalized(_ image: CGImage) throws(Problem) -> CGImage {
        let isWide = image.colorSpace.map { $0.model == .rgb && $0.isWideGamutRGB } ?? false
        guard let space = CGColorSpace(name: isWide ? CGColorSpace.displayP3 : CGColorSpace.sRGB),
              let context = CGContext(
                  data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
              )
        else { throw .writeFailed }
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        context.setFillColor(CGColor(colorSpace: space, components: [1, 1, 1, 1]) ?? CGColor(gray: 1, alpha: 1))
        context.fill(bounds)
        context.interpolationQuality = .high
        context.draw(image, in: bounds)
        guard let redrawn = context.makeImage() else { throw .writeFailed }
        return redrawn
    }

    /// A JPEG of just the pixels: no properties are copied from the
    /// source, so none of its metadata can survive.
    static func encode(_ image: CGImage) throws(Problem) -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw .writeFailed
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw .writeFailed }
        return data as Data
    }

    /// Writes to a temporary sibling, then moves it into place (refused if
    /// something is there), so a crash mid-write never leaves a partial
    /// file at `destination` to block a retry.
    static func write(_ data: Data, to destination: URL) throws(Problem) {
        let temporary = destination.deletingLastPathComponent()
            .appending(path: ".\(UUID().uuidString).preparing", directoryHint: .notDirectory)
        do {
            try data.write(to: temporary, options: [.withoutOverwriting, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            throw .writeFailed
        }
        do {
            try FileManager.default.moveItem(at: temporary, to: destination)
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            if (error as? CocoaError)?.code == .fileWriteFileExists { throw .destinationExists }
            throw .writeFailed
        }
    }
}
