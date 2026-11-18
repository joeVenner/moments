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
}

/// Turns a picked photo (HEIC, JPEG, PNG, …) into the JPEG that is
/// uploaded: at most `maxPixelSize` on its longest side (never enlarged),
/// turned upright, and carrying no metadata at all — no location, no
/// camera or device details, no capture time. Only the pixels and their
/// color profile are kept.
///
/// The image is decoded already scaled down (ImageIO subsamples while
/// decoding), so a 48 MP photo never sits in memory at full size.
public enum PhotoPreparer {
    public enum Problem: Error, Equatable, Sendable {
        /// Not an image ImageIO can read.
        case unreadable
        /// More pixels than `maxSourcePixels` (a decompression bomb or a
        /// panorama far beyond what an event photo needs).
        case tooLarge
        /// The JPEG couldn't be encoded or written.
        case writeFailed
        /// Something already exists at the destination.
        case destinationExists
    }

    /// Longest side of the uploaded photo.
    public static let maxPixelSize = 2560
    /// JPEG quality of the uploaded photo.
    public static let quality = 0.85
    /// Sources with more pixels than this are refused (~200 MP).
    public static let maxSourcePixels = 200_000_000

    /// Reads the photo at `source` and writes the upload JPEG to
    /// `destination`, which must not exist. The file is readable after
    /// first unlock, so a background upload can read it while locked.
    public static func prepare(
        source: URL, destination: URL, maxPixelSize: Int = PhotoPreparer.maxPixelSize,
        maxSourcePixels: Int = PhotoPreparer.maxSourcePixels
    ) throws(Problem) -> PreparedPhoto {
        guard let image = try decode(source, maxPixelSize: maxPixelSize, maxSourcePixels: maxSourcePixels) else {
            throw .unreadable
        }
        let data = try encode(image)
        do {
            try data.write(to: destination, options: [.withoutOverwriting, .completeFileProtectionUntilFirstUserAuthentication])
        } catch CocoaError.fileWriteFileExists {
            throw .destinationExists
        } catch {
            throw .writeFailed
        }
        return PreparedPhoto(width: image.width, height: image.height, byteCount: Int64(data.count))
    }

    /// The first image of `source`, upright and scaled to fit.
    static func decode(_ source: URL, maxPixelSize: Int, maxSourcePixels: Int) throws(Problem) -> CGImage? {
        guard let imageSource = CGImageSourceCreateWithURL(source as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(imageSource) > 0,
              let type = CGImageSourceGetType(imageSource).flatMap({ UTType($0 as String) }), type.conforms(to: .image),
              let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0
        else { return nil }
        guard width.multipliedReportingOverflow(by: height).partialValue <= maxSourcePixels,
              width <= maxSourcePixels, height <= maxSourcePixels
        else { throw .tooLarge }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            // Applies the EXIF orientation, so the pixels are upright.
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: min(maxPixelSize, max(width, height)),
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(imageSource, 0, options as CFDictionary)
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
}
