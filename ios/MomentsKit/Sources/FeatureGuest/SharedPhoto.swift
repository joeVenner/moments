import CoreGraphics
import CoreTransferable
import Foundation
import ImageIO
import MomentsDomain
import UniformTypeIdentifiers

/// A moment's photo for the share sheet: the pixels only, never its link.
/// Media links of private events carry access, so they must not leave the
/// app. Loaded when the guest picks where to share, then re-encoded, which
/// also leaves no metadata in the file.
struct SharedPhoto: Transferable, Sendable {
    /// The largest side shared, as the viewer shows it.
    static let maxPixelSize = 2400
    static let jpegQuality = 0.9

    let load: @Sendable () async throws -> CGImage

    enum EncodeError: Error { case failed }

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .jpeg) { photo in
            try jpegData(from: try await photo.load())
        }
        .suggestedFileName("Moment.jpg")
    }

    /// JPEG bytes with no metadata beyond what ImageIO writes for the pixels.
    static func jpegData(from image: CGImage, quality: Double = jpegQuality) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw EncodeError.failed
        }
        let options = [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        CGImageDestinationAddImage(destination, image, options)
        guard CGImageDestinationFinalize(destination) else { throw EncodeError.failed }
        return data as Data
    }
}

extension SharedPhoto {
    /// The moment's viewer image through the event's loader (which adds the
    /// grant itself, on our origin only); nil for videos and missing images.
    init?(media: Media, images: ThumbnailLoader) {
        guard media.kind == .image, let url = media.viewerImageURL.flatMap(URL.init(string:)) else { return nil }
        load = { try await images.image(at: url, maxPixelSize: Self.maxPixelSize) }
    }
}
