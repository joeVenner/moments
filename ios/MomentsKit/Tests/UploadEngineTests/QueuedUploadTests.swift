import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import UploadEngine

private let mib8: Int64 = 8 * 1024 * 1024
private let size = 2 * mib8 + 100
private let t0 = Date(timeIntervalSince1970: 1_000_000)
private let ref = QueuedUpload.SessionRef(id: "u1", partSize: mib8, partCount: 3)

private func item() -> QueuedUpload {
    QueuedUpload(
        eventSlug: "party",
        file: .init(relativePath: "staged/a.jpg", size: size, contentType: "image/jpeg")!,
        caption: "Cake", createdAt: t0
    )
}

private func session(
    _ item: QueuedUpload, status: UploadSession.Status = .open, size: Int64 = size, momentID: String? = nil,
    id: String = "u1", clientUploadID: UUID? = nil
) -> UploadSession {
    UploadSession(
        id: id, clientUploadID: clientUploadID ?? item.clientUploadID, status: status, contentType: "image/jpeg",
        size: size, partSize: mib8, partCount: UploadPlan.partCount(size: size, partSize: mib8)!, createdAt: t0,
        momentID: momentID
    )
}

/// An item with an open session and these parts sent.
private func uploading(_ parts: Set<Int> = []) -> QueuedUpload {
    var upload = item()
    upload.apply(.sessionStarted(session(upload)), now: t0)
    if !parts.isEmpty { upload.sendParts(parts, now: t0) }
    return upload
}

@Suite struct QueuedUploadTests {
    @Test func walksTheHappyPath() {
        var upload = item()
        #expect(upload.nextAction(now: t0) == .startSession(upload.newUpload))
        #expect(upload.newUpload.clientUploadID == upload.id)

        upload.apply(.sessionStarted(session(upload)), now: t0)
        #expect(upload.nextAction(now: t0) == .uploadParts(session: ref, parts: [1, 2, 3]))
        upload.sendParts([1, 3], now: t0)
        #expect(upload.nextAction(now: t0) == .uploadParts(session: ref, parts: [2]))
        upload.sendParts([2], now: t0)
        #expect(upload.nextAction(now: t0) == .complete(session: ref))

        upload.apply(.completeAnswered(.completed(session(upload, status: .completed, momentID: "m1"))), now: t0)
        #expect(upload.phase == .done(momentID: "m1"))
        #expect(upload.nextAction(now: t0) == .none)
    }

    @Test func findsAnAlreadyFinishedUploadOnStart() {
        var upload = item()
        upload.apply(.sessionStarted(session(upload, status: .completed, momentID: "m1")), now: t0)
        #expect(upload.phase == .done(momentID: "m1"))
    }

    @Test func resumesFromTheServersPartsAfterRelaunch() {
        var upload = uploading([1])
        upload.reconcileOnLaunch()
        #expect(upload.nextAction(now: t0) == .readSession(ref))
        upload.apply(.progressRead(UploadProgress(session: session(upload), uploadedParts: [1, 2, 3, 9])), now: t0)
        #expect(upload.uploaded == [1, 2, 3])
        #expect(upload.nextAction(now: t0) == .complete(session: ref))
    }

    // MARK: Identity

    @Test func ignoresAnswersForAnotherClientIDOrSession() {
        var upload = uploading([1])
        let before = upload
        upload.apply(.sessionStarted(session(upload, clientUploadID: UUID())), now: t0)
        upload.apply(.progressRead(UploadProgress(session: session(upload, id: "other"), uploadedParts: [1, 2, 3])), now: t0)
        upload.apply(.progressRead(UploadProgress(session: session(upload, clientUploadID: UUID()), uploadedParts: [])), now: t0)
        upload.apply(.completeAnswered(.completed(session(upload, status: .completed, clientUploadID: UUID()))), now: t0)
        #expect(upload == before)
    }

    @Test func ignoresALateStartAnswerOnceASessionIsKnown() {
        var upload = uploading([1, 2])
        upload.apply(.sessionStarted(session(upload)), now: t0)
        #expect(upload.uploaded == [1, 2])
    }

    @Test func keepsTheClientIDWhenTheGuestRetries() {
        var upload = uploading([1])
        for _ in 0 ..< QueuedUpload.maxAttempts { upload.failRequest(.storageUnavailable, now: t0) }
        #expect(upload.phase == .failed(.gaveUp))
        let id = upload.clientUploadID
        upload.retryByGuest()
        #expect(upload.clientUploadID == id)
        #expect(upload.nextAction(now: t0) == .readSession(ref))

        // Its moment was removed meanwhile: done, nothing re-uploaded.
        upload.apply(.progressRead(UploadProgress(session: session(upload, status: .completed), uploadedParts: [])), now: t0)
        #expect(upload.phase == .done(momentID: nil))
    }

    @Test func retriesFromTheStartWhenNoSessionWasKnown() {
        var upload = item()
        upload.failRequest(.guestRequired, now: t0)
        upload.retryByGuest()
        #expect(upload.phase == .prepared && upload.clientUploadID == upload.id)
    }

    @Test(arguments: [
        QueuedUpload.Failure.uploadsClosed, .eventGone, .refused,
    ])
    func leavesUnfixableFailuresAlone(failure: QueuedUpload.Failure) {
        var upload = item()
        let error: MomentsAPIError = switch failure {
        case .uploadsClosed: .uploadsClosed
        case .eventGone: .eventNotFound
        default: .invalidUpload
        }
        upload.failRequest(error, now: t0)
        upload.retryByGuest()
        #expect(upload.phase == .failed(failure))
    }

    // MARK: Cancellation and restarts

    @Test func opensAFreshSessionOnlyWhenTheServerConfirmsCancellation() {
        var upload = uploading([1, 2, 3])
        upload.apply(.completeAnswered(.notOpen), now: t0)
        #expect(upload.phase == .checking)
        #expect(upload.nextAction(now: t0.addingTimeInterval(5)) == .readSession(ref))

        let oldID = upload.clientUploadID
        upload.apply(.progressRead(UploadProgress(session: session(upload, status: .aborted), uploadedParts: [])), now: t0)
        #expect(upload.phase == .prepared && upload.clientUploadID != oldID && upload.restarts == 1)
        #expect(upload.session == nil && upload.uploaded.isEmpty)
    }

    @Test func restartsWhenStartIsRefusedAsCancelled() {
        var upload = item()
        upload.failRequest(.uploadNotOpen, now: t0)
        #expect(upload.phase == .prepared && upload.restarts == 1)
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

    @Test func neverRestartsOnAnUnknownStatus() {
        var upload = uploading([1, 2, 3])
        let id = upload.clientUploadID
        upload.apply(.completeAnswered(.notOpen), now: t0)
        upload.apply(.progressRead(UploadProgress(session: session(upload, status: .unknown("finishing")), uploadedParts: [])), now: t0)
        #expect(upload.phase == .checking && upload.clientUploadID == id)
        #expect(upload.retryAt != nil)
    }

    @Test func neverStartsOverWhenTheSessionVanished() {
        var upload = uploading([1])
        upload.failRequest(.uploadNotFound, now: t0)
        #expect(upload.phase == .failed(.sessionLost))
        upload.retryByGuest()
        #expect(upload.phase == .failed(.sessionLost))
    }

    @Test func letsTheGuestStartFreshAfterRestartsRanOut() {
        var upload = item()
        for _ in 0 ... QueuedUpload.maxRestarts { upload.apply(.sessionStarted(session(upload, status: .aborted)), now: t0) }
        #expect(upload.phase == .failed(.gaveUp) && upload.session == nil)
        upload.retryByGuest()
        #expect(upload.phase == .prepared && upload.restarts == 0)
    }

    @Test func dropsLateEventsFromASupersededSession() {
        var upload = uploading([1])
        let oldID = upload.clientUploadID
        upload.apply(.completeAnswered(.notOpen), now: t0)
        upload.apply(.progressRead(UploadProgress(session: session(upload, status: .aborted), uploadedParts: [])), now: t0)
        upload.apply(.sessionStarted(session(upload, id: "u2")), now: t0)
        let before = upload
        upload.apply(.partsUploaded([2, 3], sessionID: "u1"), now: t0)
        upload.apply(.requestFailed(.uploadConflict, clientUploadID: oldID), now: t0)
        #expect(upload == before)
    }

    @Test func ignoresAProgressReadItDidNotAskFor() {
        var upload = uploading([1, 2])
        upload.apply(.progressRead(UploadProgress(session: session(upload), uploadedParts: [])), now: t0)
        #expect(upload.uploaded == [1, 2] && upload.phase == .uploading)
    }

    @Test func givesUpIfASessionChangesItsPartLayout() {
        var upload = uploading([1])
        upload.reconcileOnLaunch()
        var changed = session(upload)
        changed = UploadSession(
            id: changed.id, clientUploadID: changed.clientUploadID, status: .open, contentType: "image/jpeg",
            size: size, partSize: 1024 * 1024 * 1024, partCount: 1, createdAt: t0
        )
        upload.apply(.progressRead(UploadProgress(session: changed, uploadedParts: [])), now: t0)
        #expect(upload.phase == .failed(.gaveUp))
    }

    @Test func finishesAfterAFewAmbiguousAnswers() {
        var upload = uploading([1, 2, 3])
        var now = t0
        var answers: [CompleteOutcome] = [.incomplete(uploadedParts: [1, 3]), .notOpen, .incomplete(uploadedParts: [1, 2])]
        for _ in 0 ..< 30 {
            if upload.isFinished { break }
            switch upload.nextAction(now: now) {
            case let .uploadParts(_, parts): upload.sendParts(Set(parts), now: now)
            case .complete:
                let answer = answers.isEmpty
                    ? .completed(session(upload, status: .completed, momentID: "m1")) : answers.removeFirst()
                upload.apply(.completeAnswered(answer), now: now)
            case .readSession: upload.apply(.progressRead(UploadProgress(session: session(upload), uploadedParts: [1, 2, 3])), now: now)
            case let .wait(until): now = until
            default: Issue.record("unexpected action")
            }
        }
        #expect(upload.phase == .done(momentID: "m1"))
    }

    @Test func offlineNeverShortensALongerWait() {
        var upload = item()
        upload.failRequest(.tooManyAttempts(retryAfterSeconds: 600), now: t0)
        upload.failRequest(.transport(.notConnectedToInternet), now: t0)
        #expect(upload.retryAt == t0.addingTimeInterval(600))
    }

    @Test func countsOtherTransportErrorsTowardGivingUp() {
        var upload = item()
        upload.failRequest(.transport(.secureConnectionFailed), now: t0)
        upload.failRequest(.transport(nil), now: t0)
        #expect(upload.attempts == 2)
    }

    @Test func refusesASessionForAnotherFile() {
        var upload = item()
        upload.apply(.sessionStarted(session(upload, size: size + 1)), now: t0)
        #expect(upload.phase == .prepared && upload.restarts == 1)
    }

    // MARK: Bounded loops

    @Test func givesUpOnAServerThatAlwaysSaysPartsAreMissing() {
        var upload = uploading()
        var now = t0
        for _ in 0 ..< 50 {
            if upload.isFinished { break }
            switch upload.nextAction(now: now) {
            case let .uploadParts(_, parts): upload.sendParts(Set(parts), now: now)
            case .complete: upload.apply(.completeAnswered(.incomplete(uploadedParts: [])), now: now)
            case let .wait(until): now = until
            default: Issue.record("unexpected action")
            }
        }
        #expect(upload.phase == .failed(.gaveUp))
        #expect(upload.rounds == QueuedUpload.maxRounds)
    }

    @Test func givesUpOnAnEndlessNotOpenOpenCycle() {
        var upload = uploading([1, 2, 3])
        var now = t0
        for _ in 0 ..< 50 {
            if upload.isFinished { break }
            switch upload.nextAction(now: now) {
            case .complete: upload.apply(.completeAnswered(.notOpen), now: now)
            case .readSession: upload.apply(.progressRead(UploadProgress(session: session(upload), uploadedParts: [1, 2, 3])), now: now)
            case let .wait(until): now = until
            default: Issue.record("unexpected action")
            }
        }
        #expect(upload.phase == .failed(.gaveUp))
    }

    @Test func backsOffAfterAnIncompleteAnswer() {
        var upload = uploading([1, 2, 3])
        upload.apply(.completeAnswered(.incomplete(uploadedParts: [1, 3])), now: t0)
        #expect(upload.nextAction(now: t0) == .wait(until: t0.addingTimeInterval(5)))
        #expect(upload.nextAction(now: t0.addingTimeInterval(5)) == .uploadParts(session: ref, parts: [2]))
    }

    // MARK: Errors

    @Test func backsOffOnRetryableErrors() {
        var upload = item()
        upload.failRequest(.storageUnavailable, now: t0)
        #expect(upload.nextAction(now: t0) == .wait(until: t0.addingTimeInterval(5)))
        for expected in [10.0, 20, 40, 80] {
            upload.failRequest(.rateLimited, now: t0)
            #expect(upload.retryAt == t0.addingTimeInterval(expected))
        }
        upload.apply(.sessionStarted(session(upload)), now: t0)
        #expect(upload.attempts == 0)
    }

    @Test func givesUpAfterMaxAttempts() {
        var upload = item()
        for _ in 1 ..< QueuedUpload.maxAttempts { upload.failRequest(.rateLimited, now: t0) }
        #expect(upload.retryAt == t0.addingTimeInterval(QueuedUpload.maxBackoff))
        #expect(!upload.isFinished)
        upload.failRequest(.rateLimited, now: t0)
        #expect(upload.phase == .failed(.gaveUp))
    }

    @Test func waitsOutOfflineSpellsWithoutGivingUp() {
        var upload = item()
        for _ in 0 ..< 100 { upload.failRequest(.transport(.notConnectedToInternet), now: t0) }
        #expect(!upload.isFinished && upload.attempts == 0)
        #expect(upload.retryAt == t0.addingTimeInterval(QueuedUpload.offlineWait))
    }

    @Test func ignoresItsOwnCancelledRequests() {
        var upload = item()
        upload.failRequest(.transport(.cancelled), now: t0)
        #expect(upload == item().withSameIDs(as: upload))
    }

    @Test func clampsAFarFutureRetryTime() {
        var upload = item()
        upload.failRequest(.storageUnavailable, now: t0.addingTimeInterval(86_400))
        #expect(upload.nextAction(now: t0) == .wait(until: t0.addingTimeInterval(QueuedUpload.maxBackoff)))
    }

    @Test(arguments: [
        (MomentsAPIError.uploadsClosed, QueuedUpload.Failure.uploadsClosed),
        (.eventNotFound, .eventGone),
        (.accessRequired, .accessLost),
        (.invalidAccess, .accessLost),
        (.guestRequired, .accessLost),
        (.invalidUpload, .refused),
        (.invalidRequest, .refused),
        (.upgradeRequired, .appTooOld),
        (.uploadsUnavailable, .unavailable),
        (.server(status: 404, code: nil), .gaveUp),
    ])
    func stopsOnTerminalErrors(error: MomentsAPIError, failure: QueuedUpload.Failure) {
        var upload = item()
        upload.failRequest(error, now: t0)
        #expect(upload.phase == .failed(failure))
        #expect(upload.nextAction(now: t0) == .none)
    }

    @Test func keepsTheRejectionAsAClosedKind() {
        var upload = uploading([1, 2, 3])
        upload.apply(.completeAnswered(.rejected(.unknown(String(repeating: "x", count: 10_000)))), now: t0)
        #expect(upload.phase == .failed(.rejected(.other)))
        var mismatch = uploading([1, 2, 3])
        mismatch.apply(.completeAnswered(.rejected(.partSizeMismatch)), now: t0)
        #expect(mismatch.phase == .failed(.rejected(.partSize)))
    }

    @Test func dropsUnsafeMomentIDs() {
        var upload = uploading([1, 2, 3])
        upload.apply(.completeAnswered(.completed(session(upload, status: .completed, momentID: "../m1"))), now: t0)
        #expect(upload.phase == .done(momentID: nil))
    }

    @Test func ignoresOutOfPhaseEvents() {
        var upload = item()
        upload.sendParts([1], now: t0)
        upload.apply(.completeAnswered(.notOpen), now: t0)
        #expect(upload == item().withSameIDs(as: upload))
        upload.failRequest(.uploadsClosed, now: t0)
        upload.apply(.sessionStarted(session(upload)), now: t0)
        #expect(upload.phase == .failed(.uploadsClosed))
    }

    // MARK: Staged files and stored records

    @Test(arguments: ["", "/etc/passwd", "../a.jpg", "staged/../../a", "a//b", "./a", "~/a", "a\\b"])
    func refusesUnsafeStagedPaths(path: String) {
        #expect(QueuedUpload.StagedFile(relativePath: path, size: 10, contentType: "image/jpeg") == nil)
    }

    @Test func refusesImpossibleSizes() {
        #expect(QueuedUpload.StagedFile(relativePath: "a.jpg", size: 0, contentType: "image/jpeg") == nil)
        #expect(QueuedUpload.StagedFile(relativePath: "a.jpg", size: QueuedUpload.maxFileSize + 1, contentType: "image/jpeg") == nil)
    }

    @Test func survivesARoundTripThroughJSON() throws {
        var upload = uploading([2])
        upload.failRequest(.storageUnavailable, now: t0)
        let data = try JSONEncoder().encode(upload)
        #expect(try JSONDecoder().decode(QueuedUpload.self, from: data) == upload)
        #expect(!String(decoding: data, as: UTF8.self).contains("http"))
    }

    @Test(arguments: [
        ("\"relativePath\":\"staged\\/a.jpg\"", "\"relativePath\":\"..\\/a.jpg\""),
        ("\"partCount\":3", "\"partCount\":0"),
        ("\"partCount\":3", "\"partCount\":99999"),
        ("\"attempts\":1", "\"attempts\":9223372036854775807"),
        ("\"schemaVersion\":1", "\"schemaVersion\":2"),
        ("\"rounds\":0", "\"rounds\":99"),
        ("\"restarts\":0", "\"restarts\":-1"),
        ("\"uploaded\":[2]", "\"uploaded\":[2,7]"),
        ("\"id\":\"u1\"", "\"id\":\"..\\/x\""),
    ])
    func refusesTamperedRecords(original: String, tampered: String) throws {
        var upload = uploading([2])
        upload.failRequest(.storageUnavailable, now: t0)
        let json = String(decoding: try JSONEncoder().encode(upload), as: UTF8.self)
        #expect(json.contains(original), "fixture drifted: \(original)")
        let bad = Data(json.replacingOccurrences(of: original, with: tampered).utf8)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(QueuedUpload.self, from: bad) }
    }
}

private extension QueuedUpload {
    /// A failure of a request made under the current client id.
    mutating func failRequest(_ error: MomentsAPIError, now: Date) {
        apply(.requestFailed(error, clientUploadID: clientUploadID), now: now)
    }

    /// Parts of the current session reached storage.
    mutating func sendParts(_ parts: Set<Int>, now: Date) {
        apply(.partsUploaded(parts, sessionID: session?.id ?? "none"), now: now)
    }

    /// A fresh item sharing `other`'s ids, to compare "nothing changed".
    func withSameIDs(as other: QueuedUpload) -> QueuedUpload {
        QueuedUpload(id: other.id, eventSlug: eventSlug, file: file, caption: caption, createdAt: createdAt)
    }
}

@Suite struct QueuedUploadDecodingTests {
    @Test func refusesAnUnsafeMomentIDOrAPhaseWithoutASession() throws {
        var done = item()
        done.apply(.sessionStarted(session(done, status: .completed, momentID: "m1")), now: t0)
        let json = String(decoding: try JSONEncoder().encode(done), as: UTF8.self)
        #expect(json.contains("\"momentID\":\"m1\""))
        let badID = Data(json.replacingOccurrences(of: "\"momentID\":\"m1\"", with: "\"momentID\":\"..\\/x\"").utf8)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(QueuedUpload.self, from: badID) }

        let fresh = String(decoding: try JSONEncoder().encode(item()), as: UTF8.self)
        #expect(fresh.contains("\"prepared\":{}"))
        let checking = Data(fresh.replacingOccurrences(of: "\"prepared\":{}", with: "\"checking\":{}").utf8)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(QueuedUpload.self, from: checking) }
    }

    @Test func reconcileIsANoOpWithoutASessionOrOnceFinished() {
        var fresh = item()
        fresh.reconcileOnLaunch()
        #expect(fresh.phase == .prepared)
        var done = item()
        done.apply(.sessionStarted(session(done, status: .completed)), now: t0)
        done.reconcileOnLaunch()
        #expect(done.phase == .done(momentID: nil))
    }
}

