import CoreGraphics
import Foundation
import Testing
@testable import FeatureGuest

private func frame() -> CGImage {
    let context = CGContext(
        data: nil, width: 4, height: 4, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    return context.makeImage()!
}

private final class Calls: @unchecked Sendable {
    private let lock = NSLock()
    private var urls: [URL] = []
    func record(_ url: URL) { lock.withLock { urls.append(url) } }
    var count: Int { lock.withLock { urls.count } }
}

private struct Unreadable: Error {}

@Suite struct VideoPosterLoaderTests {
    private let video = URL(string: "https://moments-hq.com/media/events/e/moments/v-upload")!

    @Test func aFrameIsReadOnceThenServedFromTheCache() async throws {
        let calls = Calls()
        let loader = VideoPosterLoader { url, _ in
            calls.record(url)
            return frame()
        }
        _ = try await loader.poster(for: video, maxPixelSize: 440)
        _ = try await loader.poster(for: video, maxPixelSize: 440)
        #expect(calls.count == 1)
    }

    @Test func eachSizeIsItsOwnFrame() async throws {
        let calls = Calls()
        let loader = VideoPosterLoader { url, _ in
            calls.record(url)
            return frame()
        }
        _ = try await loader.poster(for: video, maxPixelSize: 440)
        _ = try await loader.poster(for: video, maxPixelSize: 2400)
        #expect(calls.count == 2)
    }

    @Test func aFailureIsNotCachedSoScrollingBackRetries() async throws {
        let calls = Calls()
        let loader = VideoPosterLoader { url, _ in
            calls.record(url)
            if calls.count == 1 { throw Unreadable() }
            return frame()
        }
        await #expect(throws: Unreadable.self) { try await loader.poster(for: video, maxPixelSize: 440) }
        _ = try await loader.poster(for: video, maxPixelSize: 440)
        #expect(calls.count == 2)
    }

    @Test func manyVideosAllGetTheirFrameThroughTheTwoSlots() async throws {
        let loader = VideoPosterLoader { _, _ in
            try await Task.sleep(for: .milliseconds(5))
            return frame()
        }
        try await withThrowingTaskGroup(of: Void.self) { group in
            for index in 0..<8 {
                let url = URL(string: "https://moments-hq.com/media/v\(index)")!
                group.addTask { _ = try await loader.poster(for: url, maxPixelSize: 440) }
            }
            try await group.waitForAll()
        }
    }

    @Test func forgettingEverythingReadsAgain() async throws {
        let calls = Calls()
        let loader = VideoPosterLoader { url, _ in
            calls.record(url)
            return frame()
        }
        _ = try await loader.poster(for: video, maxPixelSize: 440)
        await loader.removeAll()
        _ = try await loader.poster(for: video, maxPixelSize: 440)
        #expect(calls.count == 2)
    }

    @Test func aStalledReadIsGivenUp() async throws {
        let loader = VideoPosterLoader(timeout: .milliseconds(20)) { _, _ in
            try await Task.sleep(for: .seconds(30))
            return frame()
        }
        await #expect(throws: VideoPosterLoader.LoadError.timedOut) { try await loader.poster(for: video, maxPixelSize: 440) }
    }

    /// A cell that scrolls away stops its read, so the next one isn't kept waiting.
    @Test func cancellingTheOnlyWaiterStopsTheRead() async throws {
        let calls = Calls()
        let loader = VideoPosterLoader { url, _ in
            calls.record(url)
            try await Task.sleep(for: .seconds(30))
            return frame()
        }
        let video = video
        let waiting = Task { try await loader.poster(for: video, maxPixelSize: 440) }
        while calls.count == 0 { try await Task.sleep(for: .milliseconds(2)) }
        waiting.cancel()
        await #expect(throws: (any Error).self) { try await waiting.value }
    }
}
