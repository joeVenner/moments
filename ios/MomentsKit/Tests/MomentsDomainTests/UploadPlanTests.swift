import Foundation
import Testing
@testable import MomentsDomain

@Suite struct UploadPlanTests {
    private let mib8: Int64 = 8 * 1024 * 1024

    @Test func countsPartsLikeTheServer() {
        #expect(UploadPlan.partCount(size: 0, partSize: mib8) == 1)
        #expect(UploadPlan.partCount(size: 1, partSize: mib8) == 1)
        #expect(UploadPlan.partCount(size: mib8, partSize: mib8) == 1)
        #expect(UploadPlan.partCount(size: mib8 + 1, partSize: mib8) == 2)
        #expect(UploadPlan.partCount(size: 512 * 1024 * 1024, partSize: mib8) == 64)
    }

    @Test func givesFullPartsAndAShorterLast() {
        let size = 2 * mib8 + 100
        #expect(UploadPlan.byteRange(part: 1, size: size, partSize: mib8) == 0 ..< mib8)
        #expect(UploadPlan.byteRange(part: 2, size: size, partSize: mib8) == mib8 ..< 2 * mib8)
        #expect(UploadPlan.byteRange(part: 3, size: size, partSize: mib8) == 2 * mib8 ..< size)
        #expect(UploadPlan.byteRange(part: 4, size: size, partSize: mib8) == nil)
        #expect(UploadPlan.byteRange(part: 0, size: size, partSize: mib8) == nil)
    }

    @Test func neverTrapsOnServerValues() {
        #expect(UploadPlan.partCount(size: -1, partSize: mib8) == nil)
        #expect(UploadPlan.partCount(size: 10, partSize: 0) == nil)
        #expect(UploadPlan.partCount(size: .max, partSize: .max) == 1)
        #expect(UploadPlan.partCount(size: .max, partSize: 1) == nil)
        #expect(UploadPlan.partCount(size: Int64(UploadPlan.maxParts), partSize: 1) == UploadPlan.maxParts)
        #expect(UploadPlan.byteRange(part: 1, size: .max, partSize: .max) == 0 ..< .max)
        #expect(UploadPlan.missingParts(partCount: Int.max, uploaded: []) == [])
    }

    @Test func lastPartMatchesTheServer() {
        for size in [mib8, 3 * mib8, 3 * mib8 + 1] {
            let count = UploadPlan.partCount(size: size, partSize: mib8)!
            let last = UploadPlan.byteRange(part: count, size: size, partSize: mib8)!
            #expect(Int64(last.count) == size - Int64(count - 1) * mib8)
        }
    }

    @Test func coversTheFileExactlyOnce() {
        let size: Int64 = 3 * 1000 + 7
        let count = UploadPlan.partCount(size: size, partSize: 1000)!
        let ranges = (1...count).compactMap { UploadPlan.byteRange(part: $0, size: size, partSize: 1000) }
        #expect(ranges.map(\.count).reduce(0, +) == Int(size))
        #expect(zip(ranges, ranges.dropFirst()).allSatisfy { $0.upperBound == $1.lowerBound })
    }

    @Test func listsMissingPartsInOrder() {
        #expect(UploadPlan.missingParts(partCount: 5, uploaded: [4, 1]) == [2, 3, 5])
        #expect(UploadPlan.missingParts(partCount: 2, uploaded: [1, 2, 7]) == [])
        #expect(UploadPlan.missingParts(partCount: 0, uploaded: []) == [])
    }

    @Test func checksTheSessionDescribesTheFile() {
        let session = UploadSession(
            id: "u1", clientUploadID: UUID(), status: .open, contentType: "image/jpeg", size: mib8 + 1,
            partSize: mib8, partCount: 2, createdAt: Date(timeIntervalSince1970: 0)
        )
        #expect(UploadPlan.matches(session, size: mib8 + 1, contentType: "IMAGE/JPEG"))
        #expect(!UploadPlan.matches(session, size: mib8, contentType: "image/jpeg"))
        #expect(!UploadPlan.matches(session, size: mib8 + 1, contentType: "image/png"))
        let wrongCount = UploadSession(
            id: "u1", clientUploadID: UUID(), status: .open, contentType: "image/jpeg", size: mib8 + 1,
            partSize: mib8, partCount: 3, createdAt: Date(timeIntervalSince1970: 0)
        )
        #expect(!UploadPlan.matches(wrongCount, size: mib8 + 1, contentType: "image/jpeg"))
    }

    @Test func reportsNoMissingPartsForAFinishedSession() {
        let make = { (status: UploadSession.Status) in
            UploadProgress(
                session: UploadSession(
                    id: "u1", clientUploadID: UUID(), status: status, contentType: "image/jpeg", size: 3 * self.mib8,
                    partSize: self.mib8, partCount: 3, createdAt: Date(timeIntervalSince1970: 0)
                ),
                uploadedParts: [2]
            )
        }
        #expect(make(.open).missingParts == [1, 3])
        #expect(make(.aborted).missingParts == [])
        #expect(make(.unknown("x")).missingParts == [])
    }

    @Test func redactsPartURLs() {
        let batch = PartURLBatch(
            expiresAt: Date(timeIntervalSince1970: 0),
            urls: [1: URL(string: "https://acct.r2.cloudflarestorage.com/b/k?X-Amz-Signature=secret")!]
        )
        var dumped = ""
        dump(batch, to: &dumped)
        for text in ["\(batch)", String(reflecting: batch), dumped] {
            #expect(!text.contains("secret") && !text.contains("cloudflarestorage"))
        }
    }

    @Test func readsUnknownStatusesAsNotOpen() {
        #expect(UploadSession.Status(rawValue: "open") == .open)
        #expect(UploadSession.Status(rawValue: "paused") == .unknown("paused"))
        #expect(RejectReason(rawValue: "signature_mismatch") == .signatureMismatch)
        #expect(RejectReason(rawValue: "new") == .unknown("new"))
    }
}
