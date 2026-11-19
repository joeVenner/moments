import CoreGraphics
import Foundation
import MomentsAPI
import Testing
@testable import FeatureGuest

@Suite struct GridImageTests {
    private static let thumb = URL(string: "https://moments-hq.com/media/a.thumb.jpg")!
    private static let full = URL(string: "https://moments-hq.com/media/a.jpg")!

    private static func pixel() -> CGImage {
        let context = CGContext(
            data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        return context.makeImage()!
    }

    /// Answers each URL with its scripted error, or an image; records the order.
    private final class Script: @unchecked Sendable {
        let failures: [URL: any Error]
        private(set) var asked: [URL] = []
        init(_ failures: [URL: any Error]) { self.failures = failures }
        func image(_ url: URL) throws -> CGImage {
            asked.append(url)
            if let error = failures[url] { throw error }
            return GridImageTests.pixel()
        }
    }

    @Test func usesTheThumbnailWhenItWorks() async throws {
        let script = Script([:])
        _ = try await GridImage.load([Self.thumb, Self.full]) { try script.image($0) }
        #expect(script.asked == [Self.thumb])
    }

    @Test(arguments: [
        ThumbnailLoader.LoadError.undecodable as any Error,
        MomentsAPIError.eventNotFound,
    ])
    func aBrokenThumbnailFallsBackToTheLargerImage(error: any Error) async throws {
        let script = Script([Self.thumb: error])
        _ = try await GridImage.load([Self.thumb, Self.full]) { try script.image($0) }
        #expect(script.asked == [Self.thumb, Self.full])
    }

    @Test(arguments: [
        URLError(.notConnectedToInternet) as any Error,
        MomentsAPIError.transport(.notConnectedToInternet),
        MomentsAPIError.accessRequired,
        MomentsAPIError.server(status: 503, code: nil),
        // An original over the loader's byte cap.
        MomentsAPIError.unexpectedResponse,
    ])
    func aNetworkOrAccessProblemDoesntDownloadTheFullPhoto(error: any Error) async throws {
        let script = Script([Self.thumb: error])
        await #expect(throws: (any Error).self) {
            _ = try await GridImage.load([Self.thumb, Self.full]) { try script.image($0) }
        }
        #expect(script.asked == [Self.thumb])
    }

    @Test func aCancelledLoadStopsAndReportsCancellation() async throws {
        let script = Script([Self.thumb: ThumbnailLoader.LoadError.undecodable])
        let task = Task {
            try await GridImage.load([Self.thumb, Self.full]) { url in
                withUnsafeCurrentTask { $0?.cancel() }
                return try script.image(url)
            }
        }
        await #expect(throws: CancellationError.self) { _ = try await task.value }
        #expect(script.asked == [Self.thumb])
    }

    @Test func reportsTheLastProblemWhenNothingWorks() async throws {
        let script = Script([Self.thumb: MomentsAPIError.eventNotFound, Self.full: ThumbnailLoader.LoadError.undecodable])
        await #expect(throws: ThumbnailLoader.LoadError.undecodable) {
            _ = try await GridImage.load([Self.thumb, Self.full]) { try script.image($0) }
        }
        await #expect(throws: GridImage.Problem.noImage) {
            _ = try await GridImage.load([]) { try script.image($0) }
        }
    }
}
