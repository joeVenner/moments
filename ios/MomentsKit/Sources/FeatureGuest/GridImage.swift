import CoreGraphics
import Foundation
import MomentsAPI

/// How a grid cell picks among a moment's images (`Media.gridImageURLs`).
/// Shared with the host's moderation grid.
public enum GridImage {
    enum Problem: Error, Equatable {
        /// The moment has no image a cell can show.
        case noImage
    }

    /// Loads the first image that works, in order. Moves on only when an
    /// image is damaged or gone, never on a network or access problem: an
    /// offline guest shouldn't start downloading full photos. Throws the
    /// last error otherwise.
    ///
    /// A broken image is tried again each time the cell asks (scrolled back
    /// into view), larger one included: rare, since finalize only keeps
    /// whole JPEGs. An original over the loader's byte cap stops the chain
    /// (`unexpectedResponse`), so a fallback never downloads more than that.
    public static func load(_ urls: [URL], with image: @Sendable (URL) async throws -> CGImage) async throws -> CGImage {
        var lastError: any Error = Problem.noImage
        for url in urls {
            do {
                return try await image(url)
            } catch {
                // Whatever the inner error, a cancelled load is a cancelled
                // load: the cell must not show it as a failure.
                if Task.isCancelled { throw CancellationError() }
                guard isBroken(error) else { throw error }
                lastError = error
            }
        }
        throw lastError
    }

    /// True when that image itself is bad, so a larger one is worth trying.
    static func isBroken(_ error: any Error) -> Bool {
        switch error {
        case ThumbnailLoader.LoadError.undecodable, MomentsAPIError.eventNotFound: true
        default: false
        }
    }
}
