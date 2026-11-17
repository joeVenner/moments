import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import FeatureGuest

/// A solid PNG of the given size.
private func png(width: Int, height: Int) -> Data {
    let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    context.setFillColor(CGColor(red: 0.85, green: 0.47, blue: 0.34, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let data = NSMutableData()
    let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    CGImageDestinationFinalize(destination)
    return data as Data
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func increment() { lock.withLock { value += 1 } }
    func decrement() { lock.withLock { value -= 1 } }
    var count: Int { lock.withLock { value } }
}

@Suite struct ThumbnailLoaderTests {
    @Test func downsamplesToTheRequestedSize() async throws {
        let loader = ThumbnailLoader { _ in png(width: 1200, height: 800) }
        let image = try await loader.image(at: URL(string: "https://moments-hq.com/a.png")!, maxPixelSize: 300)
        #expect(max(image.width, image.height) == 300)
        #expect(image.width > image.height)
    }

    @Test func cachesAndSharesDownloads() async throws {
        let counter = Counter()
        let loader = ThumbnailLoader { _ in
            counter.increment()
            try await Task.sleep(for: .milliseconds(50))
            return png(width: 40, height: 40)
        }
        let url = URL(string: "https://moments-hq.com/a.png")!
        async let first = loader.image(at: url, maxPixelSize: 20)
        async let second = loader.image(at: url, maxPixelSize: 20)
        _ = try await (first, second)
        _ = try await loader.image(at: url, maxPixelSize: 20)
        #expect(counter.count == 1)
        _ = try await loader.image(at: url, maxPixelSize: 30)
        #expect(counter.count == 2)
    }

    @Test func garbageIsReportedNotCached() async throws {
        let counter = Counter()
        let loader = ThumbnailLoader { _ in counter.increment(); return Data("not an image".utf8) }
        let url = URL(string: "https://moments-hq.com/a.png")!
        await #expect(throws: ThumbnailLoader.LoadError.undecodable) { _ = try await loader.image(at: url, maxPixelSize: 20) }
        await #expect(throws: ThumbnailLoader.LoadError.undecodable) { _ = try await loader.image(at: url, maxPixelSize: 20) }
        #expect(counter.count == 2)
    }

    @Test func absurdlyLargeSourcesAreRefused() {
        // 8000 x 7000 = 56 MP, over the ceiling, though the file is small.
        #expect(ThumbnailLoader.downsample(png(width: 8000, height: 7000), maxPixelSize: 100) == nil)
        #expect(ThumbnailLoader.downsample(png(width: 100, height: 100), maxPixelSize: 50) != nil)
    }

    @Test func aDownloadNobodyWaitsForIsCancelled() async throws {
        let started = Counter()
        let finished = Counter()
        let loader = ThumbnailLoader { _ in
            started.increment()
            try await Task.sleep(for: .seconds(5))
            finished.increment()
            return png(width: 10, height: 10)
        }
        let waiter = Task { try await loader.image(at: URL(string: "https://moments-hq.com/a.png")!, maxPixelSize: 10) }
        try await Task.sleep(for: .milliseconds(50))
        waiter.cancel()
        _ = await waiter.result
        try await Task.sleep(for: .milliseconds(50))
        #expect(started.count == 1 && finished.count == 0)
    }

    @Test func limiterCapsConcurrency() async {
        let limiter = Limiter(slots: 2)
        let running = Counter()
        let peak = Peak()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<8 {
                group.addTask {
                    try? await limiter.acquire()
                    running.increment()
                    await peak.record(running.count)
                    try? await Task.sleep(for: .milliseconds(5))
                    running.decrement()
                    await limiter.release()
                }
            }
        }
        #expect(await peak.value <= 2)
    }
}

extension ThumbnailLoaderTests {
    @Test func aResignedURLReusesTheCachedImage() async throws {
        let counter = Counter()
        let loader = ThumbnailLoader { _ in counter.increment(); return png(width: 10, height: 10) }
        _ = try await loader.image(at: URL(string: "https://moments-hq.com/media/a.jpg?at=1.x")!, maxPixelSize: 10)
        _ = try await loader.image(at: URL(string: "https://moments-hq.com/media/a.jpg?at=2.y")!, maxPixelSize: 10)
        #expect(counter.count == 1)
        #expect(ThumbnailLoader.cacheKey(URL(string: "https://moments-hq.com/media/b.jpg?at=1")!, maxPixelSize: 5)
            != ThumbnailLoader.cacheKey(URL(string: "https://moments-hq.com/media/a.jpg?at=1")!, maxPixelSize: 5))
    }
}

private actor Peak {
    private(set) var value = 0
    func record(_ current: Int) { value = max(value, current) }
}
