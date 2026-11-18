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
    }

    @Test func coversTheFileExactlyOnce() {
        let size: Int64 = 3 * 1000 + 7
        let count = UploadPlan.partCount(size: size, partSize: 1000)
        let ranges = (1...count).map { UploadPlan.byteRange(part: $0, size: size, partSize: 1000) }
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
            id: "u1", clientUploadID: "c1", status: .open, contentType: "image/jpeg", size: mib8 + 1,
            partSize: mib8, partCount: 2, createdAt: Date(timeIntervalSince1970: 0)
        )
        #expect(UploadPlan.matches(session, size: mib8 + 1, contentType: "IMAGE/JPEG"))
        #expect(!UploadPlan.matches(session, size: mib8, contentType: "image/jpeg"))
        #expect(!UploadPlan.matches(session, size: mib8 + 1, contentType: "image/png"))
        let wrongCount = UploadSession(
            id: "u1", clientUploadID: "c1", status: .open, contentType: "image/jpeg", size: mib8 + 1,
            partSize: mib8, partCount: 3, createdAt: Date(timeIntervalSince1970: 0)
        )
        #expect(!UploadPlan.matches(wrongCount, size: mib8 + 1, contentType: "image/jpeg"))
    }

    @Test func readsUnknownStatusesAsNotOpen() {
        #expect(UploadSession.Status(rawValue: "open") == .open)
        #expect(UploadSession.Status(rawValue: "paused") == .unknown("paused"))
    }
}
