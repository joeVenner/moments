import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import UploadEngine

private let mib8: Int64 = 8 * 1024 * 1024
private let size = 2 * mib8 + 100
private let t0 = Date(timeIntervalSince1970: 1_000_000)

private func item() -> QueuedUpload {
    QueuedUpload(
        eventSlug: "party",
        file: .init(relativePath: "staged/a.jpg", size: size, contentType: "image/jpeg"),
        caption: "Cake", createdAt: t0
    )
}

private func session(
    _ item: QueuedUpload, status: UploadSession.Status = .open, size: Int64 = size, momentID: String? = nil
) -> UploadSession {
    UploadSession(
        id: "u1", clientUploadID: item.clientUploadID, status: status, contentType: "image/jpeg", size: size,
        partSize: mib8, partCount: UploadPlan.partCount(size: size, partSize: mib8)!, createdAt: t0, momentID: momentID
    )
}

private let ref = QueuedUpload.SessionRef(id: "u1", partSize: mib8, partCount: 3)

@Suite struct QueuedUploadTests {
    @Test func walksTheHappyPath() {
        var upload = item()
        #expect(upload.nextAction(now: t0) == .startSession(upload.newUpload))
        #expect(upload.newUpload.clientUploadID == upload.id)
        #expect(upload.newUpload.caption == "Cake")

        upload.apply(.sessionStarted(session(upload)), now: t0)
        #expect(upload.nextAction(now: t0) == .uploadParts(session: ref, parts: [1, 2, 3]))

        upload.apply(.partsUploaded([1, 3]), now: t0)
        #expect(upload.nextAction(now: t0) == .uploadParts(session: ref, parts: [2]))

        upload.apply(.partsUploaded([2]), now: t0)
        #expect(upload.phase == .finishing(ref))
        #expect(upload.nextAction(now: t0) == .complete(session: ref))

        upload.apply(.completeAnswered(.completed(session(upload, status: .completed, momentID: "m1"))), now: t0)
        #expect(upload.phase == .done(momentID: "m1"))
        #expect(upload.nextAction(now: t0) == .none)
        #expect(upload.isFinished)
    }

    @Test func resumesFromTheServersParts() {
        var upload = item()
        upload.apply(.sessionStarted(session(upload)), now: t0)
        upload.apply(.progressRead(UploadProgress(session: session(upload), uploadedParts: [1, 2, 3])), now: t0)
        #expect(upload.phase == .finishing(ref))
    }

    @Test func sendsMissingPartsWhenCompleteSaysIncomplete() {
        var upload = item()
        upload.apply(.sessionStarted(session(upload)), now: t0)
        upload.apply(.partsUploaded([1, 2, 3]), now: t0)
        upload.apply(.completeAnswered(.incomplete(uploadedParts: [1, 3, 99])), now: t0)
        #expect(upload.nextAction(now: t0) == .uploadParts(session: ref, parts: [2]))
    }

    @Test func checksTheSessionWhenCompleteSaysNotOpen() {
        var upload = item()
        upload.apply(.sessionStarted(session(upload)), now: t0)
        upload.apply(.partsUploaded([1, 2, 3]), now: t0)
        upload.apply(.completeAnswered(.notOpen), now: t0)
        #expect(upload.nextAction(now: t0) == .readSession(ref))

        // Completed and since removed by the host: done, never re-uploaded.
        var removed = upload
        removed.apply(.progressRead(UploadProgress(session: session(upload, status: .completed), uploadedParts: [])), now: t0)
        #expect(removed.phase == .done(momentID: nil))

        // Cancelled: a fresh session under a new client id.
        let oldID = upload.clientUploadID
        upload.apply(.progressRead(UploadProgress(session: session(upload, status: .aborted), uploadedParts: [])), now: t0)
        #expect(upload.phase == .prepared)
        #expect(upload.clientUploadID != oldID)
        #expect(upload.restarts == 1)
    }

    @Test func boundsRestarts() {
        var upload = item()
        for _ in 0 ..< QueuedUpload.maxRestarts {
            upload.apply(.sessionStarted(session(upload, status: .aborted)), now: t0)
            #expect(upload.phase == .prepared)
        }
        upload.apply(.sessionStarted(session(upload, status: .aborted)), now: t0)
        #expect(upload.phase == .failed(.gaveUp))
    }

    @Test func refusesASessionForAnotherFile() {
        var upload = item()
        upload.apply(.sessionStarted(session(upload, size: size + 1)), now: t0)
        #expect(upload.phase == .prepared)
        #expect(upload.restarts == 1)
    }

    @Test func retriesOnePartSizeMismatchButNotWrongContent() {
        var upload = item()
        upload.apply(.sessionStarted(session(upload)), now: t0)
        upload.apply(.completeAnswered(.rejected(.partSizeMismatch)), now: t0)
        #expect(upload.phase == .prepared)

        var other = item()
        other.apply(.sessionStarted(session(other)), now: t0)
        other.apply(.completeAnswered(.rejected(.signatureMismatch)), now: t0)
        #expect(other.phase == .failed(.rejected(reason: "signature_mismatch")))
        other.retryByGuest()
        #expect(other.phase == .failed(.rejected(reason: "signature_mismatch")))
    }

    @Test func backsOffOnRetryableErrors() {
        var upload = item()
        upload.apply(.requestFailed(.transport(.notConnectedToInternet)), now: t0)
        #expect(upload.nextAction(now: t0) == .wait(until: t0.addingTimeInterval(5)))
        #expect(upload.nextAction(now: t0.addingTimeInterval(5)) == .startSession(upload.newUpload))
        upload.apply(.requestFailed(.storageUnavailable), now: t0)
        #expect(upload.retryAt == t0.addingTimeInterval(10))
        // Progress resets the back-off.
        upload.apply(.sessionStarted(session(upload)), now: t0)
        #expect(upload.attempts == 0 && upload.retryAt == nil)
    }

    @Test func capsTheBackOffAndGivesUpEventually() {
        var upload = item()
        for _ in 1 ..< QueuedUpload.maxAttempts { upload.apply(.requestFailed(.rateLimited), now: t0) }
        #expect(upload.retryAt == t0.addingTimeInterval(15 * 60))
        upload.apply(.requestFailed(.rateLimited), now: t0)
        #expect(upload.phase == .failed(.gaveUp))
        upload.retryByGuest()
        #expect(upload.phase == .prepared && upload.attempts == 0)
    }

    @Test(arguments: [
        (MomentsAPIError.uploadsClosed, QueuedUpload.Failure.uploadsClosed),
        (.eventNotFound, .eventGone),
        (.accessRequired, .accessLost),
        (.guestRequired, .accessLost),
        (.invalidUpload, .refused),
        (.upgradeRequired, .appTooOld),
        (.uploadsUnavailable, .unavailable),
    ])
    func stopsOnTerminalErrors(error: MomentsAPIError, failure: QueuedUpload.Failure) {
        var upload = item()
        upload.apply(.requestFailed(error), now: t0)
        #expect(upload.phase == .failed(failure))
        #expect(upload.nextAction(now: t0) == .none)
    }

    @Test func handlesAnUnusableSession() {
        var notOpen = item()
        notOpen.apply(.sessionStarted(session(notOpen)), now: t0)
        notOpen.apply(.requestFailed(.uploadNotOpen), now: t0)
        #expect(notOpen.phase == .checking(ref))

        var conflict = item()
        conflict.apply(.requestFailed(.uploadConflict), now: t0)
        #expect(conflict.phase == .prepared && conflict.restarts == 1)
    }

    @Test func ignoresEventsOnceFinished() {
        var upload = item()
        upload.apply(.requestFailed(.uploadsClosed), now: t0)
        upload.apply(.sessionStarted(session(upload)), now: t0)
        #expect(upload.phase == .failed(.uploadsClosed))
    }

    @Test func survivesARoundTripThroughJSON() throws {
        var upload = item()
        upload.apply(.sessionStarted(session(upload)), now: t0)
        upload.apply(.partsUploaded([2]), now: t0)
        upload.apply(.requestFailed(.transport(nil)), now: t0)
        let data = try JSONEncoder().encode(upload)
        #expect(try JSONDecoder().decode(QueuedUpload.self, from: data) == upload)
        // The record carries no URLs.
        #expect(!String(decoding: data, as: UTF8.self).contains("http"))
    }
}
