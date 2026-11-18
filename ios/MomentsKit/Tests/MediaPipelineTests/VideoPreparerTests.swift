@preconcurrency import AVFoundation
import Foundation
import Testing
@testable import MediaPipeline

/// A fresh folder per test, removed afterwards.
private final class VideoFolder {
    let url: URL
    init() throws {
        url = FileManager.default.temporaryDirectory.appending(path: "VideoPreparerTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: url) }

    var files: [String] { (try? FileManager.default.contentsOfDirectory(atPath: url.path())) ?? [] }
}

private let locationSentinel = "+48.8584+002.2945+035.000/"
private let modelSentinel = "SENTINEL-VIDEO-MODEL"
private let softwareSentinel = "SENTINEL-VIDEO-SOFTWARE"

private func item(_ key: String, _ value: String) -> AVMetadataItem {
    let item = AVMutableMetadataItem()
    item.keySpace = .quickTimeMetadata
    item.key = key as NSString
    item.value = value as NSString
    item.dataType = kCMMetadataBaseDataType_UTF8 as String
    return item
}

/// A `seconds`-long `width`×`height` H.264 movie of solid frames, with
/// location, model and software metadata, rotated by `transform`.
private func fixture(
    _ width: Int, _ height: Int, seconds: Int = 1, transform: CGAffineTransform = .identity, in folder: VideoFolder
) async throws -> URL {
    let url = folder.url.appending(path: "source-\(UUID().uuidString).mov")
    let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
    writer.metadata = [
        item("com.apple.quicktime.location.ISO6709", locationSentinel),
        item("com.apple.quicktime.model", modelSentinel),
        item("com.apple.quicktime.software", softwareSentinel),
    ]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
    ])
    input.transform = transform
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
    ])
    writer.add(input)
    try #require(writer.startWriting())
    writer.startSession(atSourceTime: .zero)
    let fps = 10
    for frame in 0 ..< seconds * fps {
        while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
        let pool = try #require(adaptor.pixelBufferPool)
        var buffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
        let pixels = try #require(buffer)
        CVPixelBufferLockBaseAddress(pixels, [])
        memset(CVPixelBufferGetBaseAddress(pixels), Int32(frame * 20 % 255), CVPixelBufferGetDataSize(pixels))
        CVPixelBufferUnlockBaseAddress(pixels, [])
        try #require(adaptor.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: CMTimeScale(fps))))
    }
    input.markAsFinished()
    await writer.finishWriting()
    try #require(writer.status == .completed)
    return url
}

private func contains(_ url: URL, _ text: String) throws -> Bool {
    try Data(contentsOf: url).range(of: Data(text.utf8)) != nil
}

struct VideoPreparerTests {
    @Test func reencodesWithoutAnyMetadata() async throws {
        let folder = try VideoFolder()
        let source = try await fixture(640, 360, in: folder)
        // Positive control: the fixture carries each field.
        for sentinel in [locationSentinel, modelSentinel, softwareSentinel] {
            #expect(try contains(source, sentinel), "fixture lacks \(sentinel)")
        }
        let output = folder.url.appending(path: "video.mp4")
        let prepared = try await VideoPreparer.prepare(source: source, destination: output)
        #expect(prepared.width == 640 && prepared.height == 360)
        #expect(abs(prepared.duration - 1) < 0.2)
        #expect(prepared.byteCount == Int64(try output.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? -1))
        for sentinel in [locationSentinel, modelSentinel, softwareSentinel, "ISO6709", "com.apple.quicktime"] {
            #expect(try !contains(output, sentinel), "\(sentinel) survived")
        }
        let asset = AVURLAsset(url: output)
        #expect(try await asset.load(.metadata).isEmpty)
        let track = try #require(try await asset.loadTracks(withMediaType: .video).first)
        let format = try #require(try await track.load(.formatDescriptions).first)
        #expect(CMFormatDescriptionGetMediaSubType(format) == kCMVideoCodecType_H264)
        #expect(Set(folder.files) == [source.lastPathComponent, "video.mp4"])
    }

    @Test func scalesDownToAtMost1080p() async throws {
        let folder = try VideoFolder()
        let source = try await fixture(3840, 2160, in: folder)
        let prepared = try await VideoPreparer.prepare(source: source, destination: folder.url.appending(path: "video.mp4"))
        #expect(prepared.width == 1920 && prepared.height == 1080)
    }

    @Test func keepsPortraitVideosUpright() async throws {
        let folder = try VideoFolder()
        // Stored landscape, shown portrait (as phones record).
        let source = try await fixture(1920, 1080, transform: CGAffineTransform(rotationAngle: .pi / 2), in: folder)
        let prepared = try await VideoPreparer.prepare(source: source, destination: folder.url.appending(path: "video.mp4"))
        #expect(prepared.width == 1080 && prepared.height == 1920)
    }

    @Test func refusesWhatIsNotAVideo() async throws {
        let folder = try VideoFolder()
        let junk = folder.url.appending(path: "junk.mov")
        try Data("not a video".utf8).write(to: junk)
        await #expect(throws: VideoPreparer.Problem.unreadable) {
            try await VideoPreparer.prepare(source: junk, destination: folder.url.appending(path: "a.mp4"))
        }
        await #expect(throws: VideoPreparer.Problem.unreadable) {
            try await VideoPreparer.prepare(source: folder.url.appending(path: "missing.mov"), destination: folder.url.appending(path: "b.mp4"))
        }
        #expect(!folder.files.contains("a.mp4") && !folder.files.contains("b.mp4"))
    }

    @Test func refusesTooLongOrTooLarge() async throws {
        let folder = try VideoFolder()
        let source = try await fixture(320, 240, seconds: 2, in: folder)
        await #expect(throws: VideoPreparer.Problem.tooLarge) {
            try await VideoPreparer.prepare(source: source, destination: folder.url.appending(path: "a.mp4"), limits: .init(duration: 1))
        }
        await #expect(throws: VideoPreparer.Problem.tooLarge) {
            try await VideoPreparer.prepare(source: source, destination: folder.url.appending(path: "b.mp4"), limits: .init(outputBytes: 100))
        }
        await #expect(throws: VideoPreparer.Problem.tooLarge) {
            try await VideoPreparer.prepare(source: source, destination: folder.url.appending(path: "c.mp4"), limits: .init(sourceBytes: 100))
        }
        #expect(folder.files == [source.lastPathComponent])
    }

    @Test func neverOverwritesTheDestination() async throws {
        let folder = try VideoFolder()
        let source = try await fixture(320, 240, in: folder)
        let output = folder.url.appending(path: "video.mp4")
        try Data("keep".utf8).write(to: output)
        await #expect(throws: VideoPreparer.Problem.destinationExists) {
            try await VideoPreparer.prepare(source: source, destination: output)
        }
        #expect(try Data(contentsOf: output) == Data("keep".utf8))
        #expect(Set(folder.files) == [source.lastPathComponent, "video.mp4"])
    }
}
