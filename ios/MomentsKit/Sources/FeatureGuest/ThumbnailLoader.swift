import CoreGraphics
import Foundation
import ImageIO
import MomentsAPI

/// Loads feed thumbnails: downloads through `MediaFetcher` (which adds the
/// private-event grant only on our origin), decodes off the loader straight
/// to the needed pixel size, caches results within a memory budget, shares
/// one download between cells that want the same image, and cancels a
/// download once no cell is waiting for it.
public actor ThumbnailLoader {
    public typealias Fetch = @Sendable (URL) async throws -> Data

    /// Decoded-bitmap budget for the in-memory cache.
    public static let cacheCostLimit = 64 * 1024 * 1024
    /// Downloads running at once; more wait their turn.
    public static let maxConcurrentLoads = 6
    public static let maxConcurrentDecodes = 2
    /// Guest uploads are untrusted: refuse images whose full size would be
    /// absurd to decode, whatever the thumbnail size.
    public static let maxSourcePixels = 50_000_000
    /// Thumbnails are small; anything bigger than this isn't one.
    public static let maxThumbnailBytes = 15 * 1024 * 1024

    private let fetch: Fetch
    private let cache = NSCache<NSString, Box>()
    private var inFlight: [String: (task: Task<CGImage, any Error>, waiters: Int)] = [:]
    private let limiter = Limiter(slots: ThumbnailLoader.maxConcurrentLoads)
    /// Decoding a large PNG can briefly need hundreds of MB: two at a time.
    private let decodeLimiter = Limiter(slots: ThumbnailLoader.maxConcurrentDecodes)

    private final class Box: @unchecked Sendable {
        // @unchecked: immutable after init; CGImage is thread-safe to read.
        let image: CGImage
        init(_ image: CGImage) { self.image = image }
    }

    public enum LoadError: Error, Equatable { case undecodable }

    public init(fetch: @escaping Fetch) {
        self.fetch = fetch
        cache.totalCostLimit = Self.cacheCostLimit
    }

    /// Feed images for one event, with the grant read for each request.
    public init(fetcher: MediaFetcher, accessGrant: @escaping @Sendable () -> String?) {
        self.init { url in
            try await fetcher.data(for: url, accessGrant: accessGrant(), maxBytes: ThumbnailLoader.maxThumbnailBytes)
        }
    }

    /// Forget every image (access to the event was lost).
    public func removeAll() {
        cache.removeAllObjects()
        for entry in inFlight.values { entry.task.cancel() }
        inFlight.removeAll()
    }

    /// The image at `url`, downsampled so its longest side is `maxPixelSize`.
    public func image(at url: URL, maxPixelSize: Int) async throws -> CGImage {
        // Memory-only key; never logged or stored.
        let key = "\(maxPixelSize)|\(url.absoluteString)"
        if let cached = cache.object(forKey: key as NSString) { return cached.image }
        let task = inFlight[key]?.task ?? start(key: key, url: url, maxPixelSize: maxPixelSize)
        inFlight[key]?.waiters += 1
        let image = try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            Task { await self.abandon(key, task) }
        }
        return image
    }

    private func start(key: String, url: URL, maxPixelSize: Int) -> Task<CGImage, any Error> {
        let fetch = self.fetch
        let limiter = self.limiter
        let decodeLimiter = self.decodeLimiter
        // Detached: download and decode run in parallel, not on this actor.
        let task = Task.detached(priority: .userInitiated) { () throws -> CGImage in
            try await limiter.acquire()
            defer { Task { await limiter.release() } }
            try Task.checkCancellation()
            let data = try await fetch(url)
            try Task.checkCancellation()
            try await decodeLimiter.acquire()
            defer { Task { await decodeLimiter.release() } }
            guard let image = Self.downsample(data, maxPixelSize: maxPixelSize) else { throw LoadError.undecodable }
            return image
        }
        inFlight[key] = (task, 0)
        Task { await self.finish(key, task) }
        return task
    }

    private func finish(_ key: String, _ task: Task<CGImage, any Error>) async {
        let result = await task.result
        guard inFlight[key]?.task == task else { return }
        inFlight[key] = nil
        if case let .success(image) = result {
            cache.setObject(Box(image), forKey: key as NSString, cost: image.bytesPerRow * image.height)
        }
    }

    /// A waiting cell went away; cancel the download if it was the last.
    private func abandon(_ key: String, _ task: Task<CGImage, any Error>) {
        guard var entry = inFlight[key], entry.task == task else { return }
        entry.waiters -= 1
        if entry.waiters <= 0 {
            task.cancel()
            inFlight[key] = nil
        } else {
            inFlight[key] = entry
        }
    }

    /// Decodes at the target size (never the full bitmap), applying EXIF
    /// orientation. Nil for unreadable or oversized sources.
    nonisolated static func downsample(_ data: Data, maxPixelSize: Int) -> CGImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions),
              CGImageSourceGetCount(source) >= 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, sourceOptions) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width.multipliedReportingOverflow(by: height).partialValue <= maxSourcePixels,
              !width.multipliedReportingOverflow(by: height).overflow
        else { return nil }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, maxPixelSize),
        ] as CFDictionary
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options)
    }
}

/// A counting semaphore for async work.
actor Limiter {
    private var available: Int
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(slots: Int) {
        available = slots
    }

    func acquire() async throws {
        if available > 0 {
            available -= 1
            return
        }
        await withCheckedContinuation { waiters.append($0) }
        // Woken with a slot handed over; give it back if we were cancelled.
        if Task.isCancelled {
            release()
            throw CancellationError()
        }
    }

    func release() {
        if waiters.isEmpty {
            available += 1
        } else {
            waiters.removeFirst().resume()
        }
    }
}
