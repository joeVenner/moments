import AVFoundation
import CoreGraphics
import Foundation

/// Still frames for videos that have no poster image (videos shared from
/// the website go to storage as they are). The frame is read straight from
/// the video file with range requests, so only a small part is downloaded.
/// Results are cached in memory; two videos are read at a time.
public actor VideoPosterLoader {
    public typealias Generate = @Sendable (_ url: URL, _ maxPixelSize: Int) async throws -> CGImage

    public static let shared = VideoPosterLoader()

    /// Decoded-bitmap budget for the cache.
    static let cacheCostLimit = 32 * 1024 * 1024
    static let maxConcurrentReads = 2

    /// A read that takes longer than this is given up (a stalled connection
    /// would otherwise hold one of the two slots for good).
    public static let defaultTimeout: Duration = .seconds(20)

    public enum LoadError: Error, Equatable { case timedOut }

    private let generate: Generate
    private let timeout: Duration
    private let cache = NSCache<NSString, Box>()
    private var inFlight: [String: (task: Task<CGImage, any Error>, waiters: Int)] = [:]
    /// Bumped by `removeAll`, so a read that finishes later isn't cached.
    private var generation = 0
    private var running = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    private final class Box: @unchecked Sendable {
        // @unchecked: immutable after init; CGImage is thread-safe to read.
        let image: CGImage
        init(_ image: CGImage) { self.image = image }
    }

    /// - Parameter generate: tests only; the default reads the frame with AVFoundation.
    public init(timeout: Duration = VideoPosterLoader.defaultTimeout, generate: @escaping Generate = VideoPosterLoader.firstFrame) {
        self.generate = generate
        self.timeout = timeout
        cache.totalCostLimit = Self.cacheCostLimit
    }

    /// A frame from the start of the video at `url`, at most `maxPixelSize`
    /// on its longest side. Cells asking for the same frame share one read,
    /// which is cancelled once none of them is waiting any more.
    public func poster(for url: URL, maxPixelSize: Int) async throws -> CGImage {
        let key = "\(maxPixelSize)|\(url.absoluteString)"
        if let cached = cache.object(forKey: key as NSString) { return cached.image }
        let startedGeneration = generation
        let task = inFlight[key]?.task ?? start(key: key, url: url, maxPixelSize: maxPixelSize)
        inFlight[key]?.waiters += 1
        let result = await withTaskCancellationHandler {
            await task.result
        } onCancel: {
            Task { await self.abandon(key, task) }
        }
        if inFlight[key]?.task == task { inFlight[key] = nil }
        let image = try result.get()
        if generation == startedGeneration {
            cache.setObject(Box(image), forKey: key as NSString, cost: image.bytesPerRow * image.height)
        }
        return image
    }

    /// Forget every frame (access to the event was lost).
    public func removeAll() {
        generation += 1
        cache.removeAllObjects()
        for entry in inFlight.values { entry.task.cancel() }
        inFlight.removeAll()
    }

    private func start(key: String, url: URL, maxPixelSize: Int) -> Task<CGImage, any Error> {
        let generate = generate
        let timeout = timeout
        let task = Task<CGImage, any Error> {
            await self.acquire()
            do {
                // Cancelled while queued (the cell scrolled away): free the slot at once.
                try Task.checkCancellation()
                let image = try await Self.withDeadline(timeout) { try await generate(url, maxPixelSize) }
                self.release()
                return image
            } catch {
                self.release()
                throw error
            }
        }
        inFlight[key] = (task, 0)
        return task
    }

    /// One waiter gave up; the read stops when it was the last.
    private func abandon(_ key: String, _ task: Task<CGImage, any Error>) {
        guard let entry = inFlight[key], entry.task == task else { return }
        if entry.waiters <= 1 {
            task.cancel()
            inFlight[key] = nil
        } else {
            inFlight[key]?.waiters -= 1
        }
    }

    private static func withDeadline(_ timeout: Duration, _ work: @escaping @Sendable () async throws -> CGImage) async throws -> CGImage {
        try await withThrowingTaskGroup(of: CGImage.self) { group in
            group.addTask { try await work() }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw LoadError.timedOut
            }
            defer { group.cancelAll() }
            guard let image = try await group.next() else { throw LoadError.timedOut }
            return image
        }
    }

    private func acquire() async {
        if running < Self.maxConcurrentReads {
            running += 1
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func release() {
        if waiters.isEmpty {
            running -= 1
        } else {
            waiters.removeFirst().resume()
        }
    }

    /// Reads a frame near the start (the very first one is often black).
    public static let firstFrame: Generate = { url, maxPixelSize in
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: maxPixelSize, height: maxPixelSize)
        // Any nearby keyframe will do: an exact frame would download more.
        generator.requestedTimeToleranceBefore = .positiveInfinity
        generator.requestedTimeToleranceAfter = .positiveInfinity
        let time = CMTime(seconds: 0.5, preferredTimescale: 600)
        return try await generator.image(at: time).image
    }
}
