import Foundation
import MomentsAPI
import MomentsDomain

/// One photo or video waiting to reach an event, and where it got to. This
/// is the record the queue persists, so it holds no part URLs (they are
/// credentials and expire) and no API secrets: only ids, sizes and the part
/// numbers already sent. All decisions live in `apply(_:now:)` and
/// `nextAction(now:)`, which are pure and fully tested; the engine around
/// them only performs I/O.
public struct QueuedUpload: Codable, Sendable, Hashable, Identifiable {
    /// The prepared file in the app's staging folder.
    public struct StagedFile: Codable, Sendable, Hashable {
        /// Relative to the staging folder (never an absolute path, which
        /// changes between installs and app updates).
        public let relativePath: String
        public let size: Int64
        public let contentType: String

        public init(relativePath: String, size: Int64, contentType: String) {
            self.relativePath = relativePath
            self.size = size
            self.contentType = contentType
        }
    }

    /// What the queue needs to remember about the server's session.
    public struct SessionRef: Codable, Sendable, Hashable {
        public let id: String
        public let partSize: Int64
        public let partCount: Int

        public init(id: String, partSize: Int64, partCount: Int) {
            self.id = id
            self.partSize = partSize
            self.partCount = partCount
        }
    }

    public enum Phase: Codable, Sendable, Hashable {
        /// Ready; no session yet (or the last one was cancelled).
        case prepared
        /// Sending parts; `uploaded` are the ones storage has.
        case uploading(SessionRef, uploaded: Set<Int>)
        /// Every part sent: asking the server to finish.
        case finishing(SessionRef)
        /// The server's answer was ambiguous (not open): read the session.
        case checking(SessionRef)
        /// The moment exists (nil if it was since removed by the host).
        case done(momentID: String?)
        /// Stopped; see `Failure`. `retryByGuest()` restarts the ones that can.
        case failed(Failure)
    }

    public enum Failure: Codable, Sendable, Hashable {
        /// The event stopped taking uploads.
        case uploadsClosed
        /// The event is gone.
        case eventGone
        /// The guest must unlock the event or join again.
        case accessLost
        /// The server refused the file (type, size or caption).
        case refused
        /// The server refused the bytes after upload (reason as sent).
        case rejected(reason: String)
        /// The app must be updated.
        case appTooOld
        /// The server has no upload storage.
        case unavailable
        /// Kept failing; the guest may try again.
        case gaveUp
    }

    /// The queue's own id; stays the same across restarts.
    public let id: UUID
    public let eventSlug: String
    public let file: StagedFile
    public let caption: String?
    public let createdAt: Date
    /// Sent as `client_upload_id`. A new one is drawn when the server
    /// cancelled the old session, so the next start opens a fresh session.
    public private(set) var clientUploadID: UUID
    public private(set) var phase: Phase
    /// Failed tries in a row (reset by progress); drives the back-off.
    public private(set) var attempts: Int
    /// Fresh sessions opened after a cancellation (bounded, so a server
    /// that keeps cancelling can't loop forever).
    public private(set) var restarts: Int
    /// Not before this time (back-off after a retryable error).
    public private(set) var retryAt: Date?

    public static let maxAttempts = 20
    public static let maxRestarts = 2

    public init(id: UUID = UUID(), eventSlug: String, file: StagedFile, caption: String?, createdAt: Date) {
        self.id = id
        self.eventSlug = eventSlug
        self.file = file
        self.caption = caption
        self.createdAt = createdAt
        clientUploadID = id
        phase = .prepared
        attempts = 0
        restarts = 0
        retryAt = nil
    }

    public var isFinished: Bool {
        switch phase {
        case .done, .failed: true
        default: false
        }
    }

    /// The request that opens (or finds again) this item's session.
    public var newUpload: NewUpload {
        NewUpload(
            clientUploadID: clientUploadID, contentType: file.contentType, size: file.size,
            caption: caption, filename: nil
        )
    }
}

// MARK: - Decisions

public extension QueuedUpload {
    /// The next thing to do for this item.
    enum Action: Sendable, Hashable {
        case startSession(NewUpload)
        /// Get URLs for these parts and send them.
        case uploadParts(session: SessionRef, parts: [Int])
        case complete(session: SessionRef)
        case readSession(SessionRef)
        /// Nothing to do before this time.
        case wait(until: Date)
        /// Done or failed.
        case none
    }

    /// What happened since the last action.
    enum Event: Sendable {
        case sessionStarted(UploadSession)
        case progressRead(UploadProgress)
        /// These parts reached storage.
        case partsUploaded(Set<Int>)
        case completeAnswered(CompleteOutcome)
        /// The last request failed.
        case requestFailed(MomentsAPIError)
    }

    func nextAction(now: Date) -> Action {
        if isFinished { return .none }
        if let retryAt, retryAt > now { return .wait(until: retryAt) }
        switch phase {
        case .prepared:
            return .startSession(newUpload)
        case let .uploading(session, uploaded):
            let missing = UploadPlan.missingParts(partCount: session.partCount, uploaded: uploaded)
            return missing.isEmpty ? .complete(session: session) : .uploadParts(session: session, parts: missing)
        case let .finishing(session):
            return .complete(session: session)
        case let .checking(session):
            return .readSession(session)
        case .done, .failed:
            return .none
        }
    }

    mutating func apply(_ event: Event, now: Date) {
        guard !isFinished else { return }
        switch event {
        case let .sessionStarted(session):
            succeeded()
            adopt(session)
        case let .progressRead(progress):
            succeeded()
            adopt(progress.session, uploaded: progress.uploadedParts)
        case let .partsUploaded(parts):
            guard case let .uploading(session, uploaded) = phase else { return }
            succeeded()
            let all = uploaded.union(parts.filter { (1...session.partCount).contains($0) })
            let missing = UploadPlan.missingParts(partCount: session.partCount, uploaded: all)
            phase = missing.isEmpty ? .finishing(session) : .uploading(session, uploaded: all)
        case let .completeAnswered(outcome):
            succeeded()
            answer(outcome)
        case let .requestFailed(error):
            fail(error, now: now)
        }
    }

    /// The guest tapped "Try again" on a failed item: start over where the
    /// failure allows it. Closed or gone events and refused files stay failed.
    mutating func retryByGuest() {
        guard case let .failed(failure) = phase else { return }
        switch failure {
        // The same bytes would be refused again.
        case .uploadsClosed, .eventGone, .refused, .rejected:
            return
        case .accessLost, .appTooOld, .unavailable, .gaveUp:
            attempts = 0
            restarts = 0
            retryAt = nil
            clientUploadID = UUID()
            phase = .prepared
        }
    }
}

// MARK: - Transitions

private extension QueuedUpload {
    mutating func succeeded() {
        attempts = 0
        retryAt = nil
    }

    /// Takes the server's view of the session.
    mutating func adopt(_ session: UploadSession, uploaded: Set<Int> = []) {
        switch session.status {
        case .completed:
            phase = .done(momentID: session.momentID)
        case .aborted, .unknown:
            restart()
        case .open:
            // A session for another file means our record and the server
            // disagree; reading its parts would send the wrong bytes.
            guard UploadPlan.matches(session, size: file.size, contentType: file.contentType) else {
                restart()
                return
            }
            let ref = SessionRef(id: session.id, partSize: session.partSize, partCount: session.partCount)
            let missing = UploadPlan.missingParts(partCount: ref.partCount, uploaded: uploaded)
            phase = missing.isEmpty && !uploaded.isEmpty ? .finishing(ref) : .uploading(ref, uploaded: uploaded)
        }
    }

    mutating func answer(_ outcome: CompleteOutcome) {
        switch outcome {
        case let .completed(session):
            phase = .done(momentID: session.momentID)
        case let .incomplete(uploadedParts):
            guard let session = currentSession else { return }
            phase = .uploading(session, uploaded: uploadedParts.filter { (1...session.partCount).contains($0) })
        case let .rejected(reason):
            // A wrong part length is most likely a resume glitch: one fresh
            // session from the same file. Wrong content won't change.
            if reason == .partSizeMismatch, restarts < Self.maxRestarts {
                restart()
            } else {
                phase = .failed(.rejected(reason: reason.rawValue))
            }
        case .notOpen:
            // Cancelled, or completed and since removed by the host: only
            // the session can tell (never re-upload a removed moment).
            guard let session = currentSession else { return }
            phase = .checking(session)
        }
    }

    mutating func fail(_ error: MomentsAPIError, now: Date) {
        if error.isRetryable {
            attempts += 1
            if attempts >= Self.maxAttempts {
                phase = .failed(.gaveUp)
            } else {
                retryAt = now.addingTimeInterval(Self.backoff(attempt: attempts))
            }
            return
        }
        switch error {
        case .uploadNotOpen, .uploadNotFound, .uploadConflict:
            // The session (or this client id) is unusable: check it if we
            // have one, otherwise open a fresh one.
            if let session = currentSession, error == .uploadNotOpen {
                phase = .checking(session)
            } else {
                restart()
            }
        case .uploadsClosed: phase = .failed(.uploadsClosed)
        case .eventNotFound: phase = .failed(.eventGone)
        case .accessRequired, .invalidAccess, .guestRequired, .tooManyAttempts, .accessUnavailable:
            phase = .failed(.accessLost)
        case .invalidUpload, .invalidRequest: phase = .failed(.refused)
        case .upgradeRequired: phase = .failed(.appTooOld)
        case .uploadsUnavailable: phase = .failed(.unavailable)
        case .nicknameTaken, .momentNotFound, .transport, .rateLimited, .tooManyUploads,
             .storageUnavailable, .unexpectedResponse, .server:
            phase = .failed(.gaveUp)
        }
    }

    /// Draws a new client id so the next start opens a fresh session.
    mutating func restart() {
        guard restarts < Self.maxRestarts else {
            phase = .failed(.gaveUp)
            return
        }
        restarts += 1
        clientUploadID = UUID()
        phase = .prepared
    }

    var currentSession: SessionRef? {
        switch phase {
        case let .uploading(session, _), let .finishing(session), let .checking(session): session
        case .prepared, .done, .failed: nil
        }
    }

    /// 5 s, 10 s, 20 s ... capped at 15 minutes.
    static func backoff(attempt: Int) -> TimeInterval {
        min(15 * 60, 5 * pow(2, Double(min(attempt - 1, 20))))
    }
}
