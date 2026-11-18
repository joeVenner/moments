import Foundation
import Testing
@testable import MediaPipeline

/// A box: 32-bit size, type, payload.
private func box(_ type: String, _ payload: [UInt8]) -> [UInt8] {
    let size = UInt32(8 + payload.count)
    return withUnsafeBytes(of: size.bigEndian, Array.init) + Array(type.utf8) + payload
}

private func box(_ type: String, _ children: [[UInt8]]) -> [UInt8] { box(type, children.flatMap { $0 }) }

/// A full-box header with version and 0xAB-filled times, then 4 more bytes.
private func header(_ type: String, version: UInt8) -> [UInt8] {
    box(type, [version, 0, 0, 0] + [UInt8](repeating: 0xAB, count: version == 1 ? 16 : 8) + [1, 2, 3, 4])
}

private func scrubbed(_ bytes: [UInt8]) throws -> [UInt8] {
    let url = FileManager.default.temporaryDirectory.appending(path: "scrub-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: url) }
    try Data(bytes).write(to: url)
    try MP4Scrub.scrub(url)
    return Array(try Data(contentsOf: url))
}

struct MP4ScrubTests {
    @Test func blanksMetadataAndHeaderTimesKeepingTheLayout() throws {
        let secret = Array("SECRET-LOCATION".utf8)
        let file = box("ftyp", Array("isom".utf8))
            + box("moov", [
                header("mvhd", version: 0),
                box("udta", [box("\u{A9}xyz", secret)]),
                box("trak", [
                    header("tkhd", version: 1),
                    box("meta", secret),
                    box("mdia", [header("mdhd", version: 0), box("hdlr", [9, 9])]),
                ]),
            ])
            + box("udta", secret)
            + box("mdat", [7, 7, 7])
        let output = try scrubbed(file)
        #expect(output.count == file.count)
        let text = Data(output)
        for gone in ["SECRET", "udta", "meta", "\u{A9}xyz"] {
            #expect(text.range(of: Data(gone.utf8)) == nil, "\(gone) survived")
        }
        #expect(!output.contains(0xAB))
        // Everything else is untouched.
        #expect(Array(output.suffix(11)) == box("mdat", [7, 7, 7]))
        #expect(text.range(of: Data([1, 2, 3, 4])) != nil)
        #expect(text.range(of: Data(box("hdlr", [9, 9]))) != nil)
    }

    @Test func blanksMetadataNestedDeeperAndXMP() throws {
        let secret = Array("SECRET".utf8)
        let file = box("uuid", secret)
            + box("moov", [
                header("mvhd", version: 0),
                box("trak", [box("mdia", [box("minf", [box("udta", secret), box("stbl", [box("meta", secret)])])])]),
            ])
        let output = Data(try scrubbed(file))
        #expect(output.count == file.count)
        for gone in ["SECRET", "uuid", "udta", "meta"] {
            #expect(output.range(of: Data(gone.utf8)) == nil, "\(gone) survived")
        }
        #expect(output.range(of: Data("minf".utf8)) != nil && output.range(of: Data("stbl".utf8)) != nil)
    }

    @Test func refusesTooDeepNesting() {
        var nested = box("mdia", [UInt8]())
        for _ in 0 ..< 20 { nested = box("mdia", nested) }
        #expect(throws: MP4Scrub.Problem.malformed) { try scrubbed(box("moov", nested)) }
    }

    @Test(arguments: [
        // No movie box.
        box("ftyp", Array("isom".utf8)) + box("mdat", [1]),
        // A box longer than the file.
        box("ftyp", Array("isom".utf8)) + [0, 0, 1, 0] + Array("moov".utf8),
        // A child running past its parent.
        box("moov", [[0, 0, 0, 99] + Array("trak".utf8)]),
        // A child smaller than a header.
        box("moov", [[0, 0, 0, 4] + Array("trak".utf8)]),
        // A header too short for its times.
        box("moov", [box("mvhd", [1, 0, 0, 0, 0, 0])]),
    ])
    func refusesMalformedFiles(bytes: [UInt8]) {
        #expect(throws: MP4Scrub.Problem.malformed) { try scrubbed(bytes) }
    }
}
