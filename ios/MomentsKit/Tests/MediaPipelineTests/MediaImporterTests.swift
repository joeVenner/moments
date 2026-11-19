import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import MediaPipeline

private func writeJPEG(_ width: Int, _ height: Int, to url: URL) throws {
    let context = try #require(CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ))
    context.setFillColor(red: 0.8, green: 0.4, blue: 0.3, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try #require(context.makeImage())
    let destination = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    try #require(CGImageDestinationFinalize(destination))
}

private func thumbnailPixels(_ url: URL) throws -> (width: Int, height: Int) {
    let source = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
    let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
    #expect(CGImageSourceGetType(source) as String? == UTType.jpeg.identifier)
    return (try #require(properties[kCGImagePropertyPixelWidth] as? Int), try #require(properties[kCGImagePropertyPixelHeight] as? Int))
}

struct MediaImporterTests {
    @Test func preparesAPhotoAndDeletesThePickedCopy() async throws {
        let folder = try VideoFolder()
        let picked = folder.url.appending(path: "picked.jpg")
        try writeJPEG(3000, 2000, to: picked)
        let item = folder.url.appending(path: "item")
        // A leftover of an interrupted attempt is swept.
        try FileManager.default.createDirectory(at: item, withIntermediateDirectories: true)
        try Data("partial".utf8).write(to: item.appending(path: ".\(UUID().uuidString).preparing"))

        let media = try await MediaImporter.importMedia(PickedMedia(url: picked, kind: .photo), into: item)
        #expect(media.name == MediaImporter.photoName && media.contentType == "image/jpeg")
        #expect(media.width == 2560 && media.height == 1707 && media.duration == nil)
        let files = try FileManager.default.contentsOfDirectory(atPath: item.path()).sorted()
        #expect(files == [MediaImporter.photoName, MediaImporter.thumbnailName])
        let thumbnail = try #require(media.thumbnail)
        #expect(thumbnail.name == MediaImporter.thumbnailName)
        #expect(thumbnail.byteCount == Int64(try item.appending(path: thumbnail.name).resourceValues(forKeys: [.fileSizeKey]).fileSize ?? -1))
        #expect(media.byteCount == Int64(try item.appending(path: media.name).resourceValues(forKeys: [.fileSizeKey]).fileSize ?? -1))
        #expect(!FileManager.default.fileExists(atPath: picked.path()))
    }

    @Test func preparesAVideo() async throws {
        let folder = try VideoFolder()
        let picked = try await fixture(640, 360, in: folder)
        let item = folder.url.appending(path: "item")
        let media = try await MediaImporter.importMedia(PickedMedia(url: picked, kind: .video), into: item)
        #expect(media.name == MediaImporter.videoName && media.contentType == "video/mp4")
        #expect(media.width == 640 && media.height == 360)
        #expect(abs((media.duration ?? 0) - 1) < 0.2)
        #expect(!FileManager.default.fileExists(atPath: picked.path()))
        let thumbnail = try #require(media.thumbnail)
        let size = try thumbnailPixels(item.appending(path: thumbnail.name))
        #expect(size.width == 400 && size.height == 225)
        // The video's own metadata (VideoPreparer strips it too) never reaches the frame.
        let data = try Data(contentsOf: item.appending(path: thumbnail.name))
        #expect(data.range(of: Data("<x:xmpmeta".utf8)) == nil)
    }

    @Test func replacesTheFileOfAnEarlierAttempt() async throws {
        let folder = try VideoFolder()
        let item = folder.url.appending(path: "item")
        try FileManager.default.createDirectory(at: item, withIntermediateDirectories: true)
        try Data("old".utf8).write(to: item.appending(path: MediaImporter.photoName))
        try Data("old thumb".utf8).write(to: item.appending(path: MediaImporter.thumbnailName))
        let picked = folder.url.appending(path: "picked.jpg")
        try writeJPEG(100, 100, to: picked)
        let media = try await MediaImporter.importMedia(PickedMedia(url: picked, kind: .photo), into: item)
        #expect(media.width == 100)
        // The earlier thumbnail is replaced by this file's.
        #expect(try thumbnailPixels(item.appending(path: try #require(media.thumbnail).name)).width == 100)
    }

    @Test func mapsProblemsAndAlwaysDeletesThePickedCopy() async throws {
        let folder = try VideoFolder()
        let item = folder.url.appending(path: "item")
        for kind in [PickedMedia.Kind.photo, .video] {
            let junk = folder.url.appending(path: "junk-\(kind)")
            try Data("not media".utf8).write(to: junk)
            await #expect(throws: MediaImporter.Problem.unsupported) {
                try await MediaImporter.importMedia(PickedMedia(url: junk, kind: kind), into: item)
            }
            #expect(!FileManager.default.fileExists(atPath: junk.path()))
        }
        let long = try await fixture(320, 240, seconds: 2, in: folder)
        await #expect(throws: MediaImporter.Problem.tooLarge) {
            try await MediaImporter.importMedia(PickedMedia(url: long, kind: .video), into: item, videoLimits: .init(duration: 1))
        }
        #expect(try FileManager.default.contentsOfDirectory(atPath: item.path()).isEmpty)
    }

    @Test func keepsThePickedCopyWhenWorthRetrying() async throws {
        let folder = try VideoFolder()
        let picked = folder.url.appending(path: "picked.jpg")
        try writeJPEG(50, 50, to: picked)
        // The item folder can't be made: a file is in its way.
        let blocker = folder.url.appending(path: "blocker")
        try Data("x".utf8).write(to: blocker)
        let media = PickedMedia(url: picked, kind: .photo)
        await #expect(throws: MediaImporter.Problem.failed) {
            try await MediaImporter.importMedia(media, into: blocker.appending(path: "item"))
        }
        #expect(FileManager.default.fileExists(atPath: picked.path()))
        // Retrying the same picked media works, then deletes it.
        _ = try await MediaImporter.importMedia(media, into: folder.url.appending(path: "item"))
        #expect(!FileManager.default.fileExists(atPath: picked.path()))
    }

    @Test func refusesASecondImportIntoTheSameFolder() async throws {
        let folder = try VideoFolder()
        let item = folder.url.appending(path: "item")
        let picked = folder.url.appending(path: "picked.jpg")
        try writeJPEG(50, 50, to: picked)
        // An import is running for this folder (spelled differently).
        #expect(ActiveFolders.shared.claim(folder.url.appending(path: "x/../item")))
        await #expect(throws: MediaImporter.Problem.busy) {
            try await MediaImporter.importMedia(PickedMedia(url: picked, kind: .photo), into: item)
        }
        #expect(FileManager.default.fileExists(atPath: picked.path()))
        ActiveFolders.shared.release(item)
        _ = try await MediaImporter.importMedia(PickedMedia(url: picked, kind: .photo), into: item)
        // Released after the import too.
        #expect(ActiveFolders.shared.claim(item))
        ActiveFolders.shared.release(item)
    }

    @Test func refusesLinksAndFolders() throws {
        let folder = try VideoFolder()
        let inbox = folder.url.appending(path: "inbox")
        let target = folder.url.appending(path: "target.jpg")
        try Data("x".utf8).write(to: target)
        let link = folder.url.appending(path: "link.jpg")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        #expect(throws: PickedMedia.AdoptError.notAFile) { try PickedMedia.adopt(link, kind: .photo, into: inbox) }
        #expect(throws: PickedMedia.AdoptError.notAFile) { try PickedMedia.adopt(folder.url, kind: .photo, into: inbox) }
        let long = folder.url.appending(path: "a.toolongext")
        try Data("x".utf8).write(to: long)
        #expect(try PickedMedia.adopt(long, kind: .photo, into: inbox).url.pathExtension == "bin")
        let copied = try PickedMedia.adopt(target, kind: .photo, into: inbox)
        #expect(try inbox.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        #expect(FileManager.default.fileExists(atPath: copied.url.path()))
    }

    @Test func adoptsPickerFilesUnderFreshPlainNames() throws {
        let folder = try VideoFolder()
        let inbox = folder.url.appending(path: "inbox")
        let received = folder.url.appending(path: "IMG 0001 ünïcode.MOV")
        try Data("movie".utf8).write(to: received)
        let picked = try PickedMedia.adopt(received, kind: .video, into: inbox)
        #expect(picked.kind == .video && picked.url.pathExtension == "mov")
        #expect(picked.url.deletingLastPathComponent().standardizedFileURL == inbox.standardizedFileURL)
        #expect(UUID(uuidString: picked.url.deletingPathExtension().lastPathComponent) != nil)
        #expect(try Data(contentsOf: picked.url) == Data("movie".utf8))

        try Data("x".utf8).write(to: folder.url.appending(path: "noext"))
        #expect(try PickedMedia.adopt(folder.url.appending(path: "noext"), kind: .photo, into: inbox).url.pathExtension == "bin")
        PickedMedia.clearInbox(inbox)
        #expect(!FileManager.default.fileExists(atPath: inbox.path()))
    }
}
