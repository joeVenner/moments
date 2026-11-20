import Foundation
import MomentsAPI
import MomentsDomain

/// One photo or video waiting to reach an event, and where it got to. This
/// is the record the queue persists, so it holds no part URLs (they are
/// credentials and expire) and no API secrets: only ids, sizes and the part
/// numbers already sent. All decisions live in `apply(_:now:)` and
/// `nextAction(now:)`, which are pure and fully tested; the engine around
/// them only performs I/O.
///
/// Two rules shape everything here:
/// - The client upload id changes only when the server confirmed the old
///   session was cancelled (or the id was used for another file). Starting
///   is idempotent per id, so keeping it is what stops a retry from making
///   a second moment, or re-uploading one the host removed.
/// - Every loop is bounded and backed off, even against a server that keeps
///   answering "parts missing" or "not open".
public struct QueuedUpload: Codable, Sendable, Hashable, Identifiable {
    /// The prepared file in the app's staging folder.
    public struct StagedFile: Codable, Sendable, Hashable {
        /// Relative to the staging folder: never absolute, never `..`, so a
        /// tampered record can't point the engine at another file.
        public let relativePath: String
        public let size: Int64
        public let contentType: String

        /// Nil unless the path is a plain relative path and the size is one
        /// the server accepts.
        public init?(relativePath: String, size: Int64, contentType: String) {
            guard Self.isSafe(relativePath: relativePath), size > 0, size <= QueuedUpload.maxFileSize,
                  !contentType.isEmpty, contentType.count <= 100
            else { return nil }
            self.relativePath = relativePath
            self.size = size
            self.contentType = contentType
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            guard let file = StagedFile(
                relativePath: try container.decode(String.self, forKey: .relativePath),
                size: try container.decode(Int64.self, forKey: .size),
                contentType: try container.decode(String.self, forKey: .contentType)
            ) else {
                throw DecodingError.dataCorruptedError(forKey: .relativePath, in: container, debugDescription: "invalid staged file")
            }
            self = file
        }

        static func isSafe(relativePath path: String) -> Bool {
            guard !path.isEmpty, path.count <= 255, !path.hasPrefix("/"), !path.hasPrefix("~"),
                  !path.contains("\\"), !path.contains("\0")
            else { return false }
            let components = path.split(separator: "/", omittingEmptySubsequences: false)
            return components.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
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
        /// Ready to open (or find again) the session.
        case prepared
        /// Sending the parts storage doesn't have yet.
        case uploading
        /// Every part sent: asking the server to finish.
        case finishing
        /// The state is unclear (app relaunch, "not open", unknown status):
        /// read the session before doing anything else.
        case checking
        /// The moment exists (nil if it was since removed by the host).
        case done(momentID: String?)
        /// Stopped; see `Failure`. `retryByGuest()` resumes the ones that can.
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
        /// The server refused the bytes after upload.
        case rejected(RejectKind)
        /// The app must be updated.
        case appTooOld
        /// The server has no upload storage.
        case unavailable
        /// Kept failing; the guest may try again.
        case gaveUp
        /// The server no longer knows this upload. It may have finished and
        /// been removed by the host, so it is never started over.
        case sessionLost
        /// The staged file is gone or changed; there is nothing to send.
        case fileLost
    }

    /// Why the bytes were refused, as a closed set (a server string is
    /// never stored or shown as is).
    public enum RejectKind: String, Codable, Sendable, Hashable {
        case partSize, object, signature, other

        init(_ reason: RejectReason) {
            switch reason {
            case .partSizeMismatch: self = .partSize
            case .objectMismatch: self = .object
            case .signatureMismatch: self = .signature
            case .unknown: self = .other
            }
        }
    }

    /// Bumped when the stored shape changes; newer records are refused.
    public static let schemaVersion = 1
    public static let maxAttempts = 20
    public static let maxRestarts = 2
    /// "Parts missing" / "not open" answers in a row without new progress.
    public static let maxRounds = 5
    public static let maxBackoff: TimeInterval = 15 * 60
    /// Wait between tries while offline (doesn't count toward giving up).
    public static let offlineWait: TimeInterval = 30
    /// The server's limit for direct uploads (`MAX_DIRECT_UPLOAD_BYTES`).
    public static let maxFileSize: Int64 = 512 * 1024 * 1024

    public private(set) var schemaVersion = QueuedUpload.schemaVersion
    /// The queue's own id; stays the same across restarts.
    public let id: UUID
    public let eventSlug: String
    public let file: StagedFile
    public let caption: String?
    public let createdAt: Date
    /// The feed thumbnail staged beside the file, if one was made. Sent
    /// once per session, before the parts; never holds the upload back.
    public let thumbnail: StagedFile?
    /// The session the thumbnail was last sent (or tried) for. A failed try
    /// isn't repeated for that session, not even by "Try again": the moment
    /// just shows its file. A new session (after a restart) tries again.
    public private(set) var thumbnailSentFor: String?
    /// Sent as `client_upload_id`.
    public private(set) var clientUploadID: UUID
    public private(set) var phase: Phase
    /// The server session, once known; kept through failures so a retry
    /// resumes it instead of starting blind.
    public private(set) var session: SessionRef?
    /// Parts storage has (as far as we know).
    public private(set) var uploaded: Set<Int>
    /// Failed tries in a row; drives the back-off.
    public private(set) var attempts: Int
    /// Fresh sessions opened after a confirmed cancellation.
    public private(set) var restarts: Int
    /// Ambiguous answers in a row without progress.
    public private(set) var rounds: Int
    /// Not before this time.
    public private(set) var retryAt: Date?

    public init(
        id: UUID = UUID(), eventSlug: String, file: StagedFile, thumbnail: StagedFile? = nil, caption: String?, createdAt: Date
    ) {
        self.id = id
        self.eventSlug = eventSlug
        self.file = file
        self.thumbnail = thumbnail
        thumbnailSentFor = nil
        self.caption = caption
        self.createdAt = createdAt
        clientUploadID = id
        phase = .prepared
        session = nil
        uploaded = []
        attempts = 0
        restarts = 0
        rounds = 0
        retryAt = nil
    }

    /// A failure "Try again" can fix (the others never will).
    public var canRetryByGuest: Bool {
        guard case let .failed(failure) = phase else { return false }
        switch failure {
        case .uploadsClosed, .eventGone, .refused, .rejected, .sessionLost, .fileLost: return false
        case .accessLost, .appTooOld, .unavailable, .gaveUp: return true
        }
    }

    /// Share of the parts storage has (0 before a session exists).
    public var uploadedFraction: Double {
        guard let session, session.partCount > 0 else { return 0 }
        return min(1, Double(uploaded.count) / Double(session.partCount))
    }

    public var isFinished: Bool {
        switch phase {
        case .done, .failed: true
        default: false
        }
    }

    /// The thumbnail still to send for `session`: one the server can take
    /// (a JPEG within its limit), not yet tried for this session.
    func pendingThumbnail(for session: SessionRef) -> StagedFile? {
        // Never the main file under another name (a tampered record).
        guard let thumbnail, thumbnailSentFor != session.id, thumbnail.contentType == Self.thumbnailContentType,
              thumbnail.size <= Int64(ThumbnailURL.maxSize), thumbnail.relativePath != file.relativePath
        else { return nil }
        return thumbnail
    }

    static let thumbnailContentType = "image/jpeg"

    /// The request that opens (or finds again) this item's session.
    public var newUpload: NewUpload {
        NewUpload(clientUploadID: clientUploadID, contentType: file.contentType, size: file.size, caption: caption, filename: nil)
    }
}

// MARK: - Decisions

public extension QueuedUpload {
    /// The next thing to do for this item.
    enum Action: Sendable, Hashable {
        case startSession(NewUpload)
        /// Send the feed thumbnail (once per session, before the parts).
        case sendThumbnail(session: SessionRef, file: StagedFile)
        /// Get URLs for these parts and send them.
        case uploadParts(session: SessionRef, parts: [Int])
        case complete(session: SessionRef)
        case readSession(SessionRef)
        /// Nothing to do before this time.
        case wait(until: Date)
        /// Done or failed.
        case none
    }

    /// What happened since the last action. Events that carry an id are
    /// dropped when it isn't the item's current one, so a late answer from
    /// a superseded request can't change a newer session.
    enum Event: Sendable {
        case sessionStarted(UploadSession)
        case progressRead(UploadProgress)
        /// These parts of session `sessionID` reached storage.
        case partsUploaded(Set<Int>, sessionID: String)
        case completeAnswered(CompleteOutcome)
        /// A request made under `clientUploadID` failed.
        case requestFailed(MomentsAPIError, clientUploadID: UUID)
        /// The staged file can no longer be read as recorded.
        case fileLost(clientUploadID: UUID)
        /// The thumbnail for session `sessionID` was sent, or failed: either
        /// way it isn't tried again for that session.
        case thumbnailHandled(sessionID: String)
    }

    func nextAction(now: Date) -> Action {
        if isFinished { return .none }
        // Clamped, so a clock set back can't park an item for days.
        if let retryAt, retryAt > now { return .wait(until: min(retryAt, now.addingTimeInterval(Self.maxBackoff))) }
        switch (phase, session) {
        case (.prepared, _), (.uploading, nil), (.finishing, nil), (.checking, nil):
            return .startSession(newUpload)
        case let (.uploading, session?), let (.finishing, session?):
            if let thumbnail = pendingThumbnail(for: session) { return .sendThumbnail(session: session, file: thumbnail) }
            guard phase == .uploading else { return .complete(session: session) }
            let missing = UploadPlan.missingParts(partCount: session.partCount, uploaded: uploaded)
            return missing.isEmpty ? .complete(session: session) : .uploadParts(session: session, parts: missing)
        case let (.checking, session?):
            return .readSession(session)
        case (.done, _), (.failed, _):
            return .none
        }
    }

    mutating func apply(_ event: Event, now: Date) {
        guard !isFinished else { return }
        switch event {
        case let .sessionStarted(started):
            // Only an answer to our start, for our current id.
            guard session == nil, started.clientUploadID == clientUploadID else { return }
            adopt(started, uploaded: [], now: now)
        case let .progressRead(progress):
            // Only the read we asked for while checking.
            guard phase == .checking, let session, progress.session.clientUploadID == clientUploadID,
                  progress.session.id == session.id
            else { return }
            adopt(progress.session, uploaded: progress.uploadedParts, now: now)
        case let .partsUploaded(parts, sessionID):
            guard phase == .uploading, let session, session.id == sessionID else { return }
            record(parts, of: session)
        case let .completeAnswered(outcome):
            guard phase == .finishing || phase == .uploading, session != nil else { return }
            answer(outcome, now: now)
        case let .requestFailed(error, requestClientID):
            guard requestClientID == clientUploadID else { return }
            fail(error, now: now)
        case let .fileLost(requestClientID):
            guard requestClientID == clientUploadID else { return }
            phase = .failed(.fileLost)
            retryAt = nil
        case let .thumbnailHandled(sessionID):
            guard thumbnail != nil, let session, session.id == sessionID else { return }
            thumbnailSentFor = sessionID
        }
    }

    /// After a relaunch the record may be behind storage (a background
    /// session finished parts while the app was gone): read the session
    /// before sending anything.
    mutating func reconcileOnLaunch() {
        guard !isFinished, session != nil else { return }
        phase = .checking
    }

    /// The guest tapped "Try again" on a failed item. Resumes the known
    /// session under the same client id (so a finished upload is found, not
    /// repeated). Closed or gone events and refused files stay failed.
    mutating func retryByGuest() {
        guard canRetryByGuest else { return }
        attempts = 0
        rounds = 0
        retryAt = nil
        // Without a session (never opened, or confirmed cancelled) a fresh
        // start is safe, so the restart budget starts over too.
        if session == nil { restarts = 0 }
        phase = session == nil ? .prepared : .checking
    }
}

// MARK: - Transitions

private extension QueuedUpload {
    /// Takes the server's view of our session.
    mutating func adopt(_ server: UploadSession, uploaded serverParts: Set<Int>, now: Date) {
        switch server.status {
        case .completed:
            phase = .done(momentID: server.momentID.flatMap(Self.validID))
        case .aborted:
            restart()
        case .unknown:
            // Perhaps a newer server's "finishing": wait and look again,
            // never restart (that could duplicate the moment).
            guard let ref = sessionRef(for: server), take(ref) else { return giveUp() }
            ambiguous(now: now)
            if case .failed = phase { return }
            phase = .checking
        case .open:
            // A session for another file means our record and the server
            // disagree; reading its parts would send the wrong bytes.
            guard UploadPlan.matches(server, size: file.size, contentType: file.contentType),
                  let ref = sessionRef(for: server)
            else { return restart() }
            // The same session can't change its part layout.
            guard take(ref) else { return giveUp() }
            attempts = 0
            uploaded = serverParts.filter { $0 >= 1 && $0 <= ref.partCount }
            phase = UploadPlan.missingParts(partCount: ref.partCount, uploaded: uploaded).isEmpty ? .finishing : .uploading
        }
    }

    /// Records the session; a different one starts its own round count.
    /// False when the known session came back with another part layout.
    mutating func take(_ ref: SessionRef) -> Bool {
        if let session, session.id == ref.id { return session == ref }
        rounds = 0
        session = ref
        return true
    }

    mutating func record(_ parts: Set<Int>, of session: SessionRef) {
        let valid = parts.filter { $0 >= 1 && $0 <= session.partCount }
        guard !valid.isSubset(of: uploaded) else { return }
        uploaded.formUnion(valid)
        madeProgress()
        if UploadPlan.missingParts(partCount: session.partCount, uploaded: uploaded).isEmpty { phase = .finishing }
    }

    mutating func answer(_ outcome: CompleteOutcome, now: Date) {
        switch outcome {
        case let .completed(server):
            guard server.clientUploadID == clientUploadID, server.status == .completed, server.id == session?.id
            else { return }
            phase = .done(momentID: server.momentID.flatMap(Self.validID))
        case let .incomplete(serverParts):
            // Every "parts missing" counts, so a server that always says it
            // (even after we resend) ends in `gaveUp`, not an endless upload.
            guard let session else { return }
            ambiguous(now: now)
            if case .failed = phase { return }
            uploaded = serverParts.filter { $0 >= 1 && $0 <= session.partCount }
            phase = UploadPlan.missingParts(partCount: session.partCount, uploaded: uploaded).isEmpty ? .finishing : .uploading
        case let .rejected(reason):
            // The same bytes would be refused again.
            phase = .failed(.rejected(RejectKind(reason)))
        case .notOpen:
            // Cancelled, or completed and since removed by the host: only
            // the session can tell (never re-upload a removed moment).
            ambiguous(now: now)
            if case .failed = phase { return }
            phase = .checking
        }
    }

    mutating func fail(_ error: MomentsAPIError, now: Date) {
        if case let .transport(code) = error {
            // The app cancelled its own request: not a failure.
            if code == .cancelled { return }
            if let code, Self.offlineCodes.contains(code) {
                // Never shortens a longer wait already set.
                retryAt = max(retryAt ?? .distantPast, now.addingTimeInterval(Self.offlineWait))
                return
            }
        }
        if error.isRetryable {
            attempts += 1
            if attempts >= Self.maxAttempts { return giveUp() }
            retryAt = now.addingTimeInterval(Self.backoff(attempt: attempts))
            return
        }
        switch error {
        case .uploadNotOpen:
            if session == nil {
                // Our start was refused: this client id's session was
                // cancelled (confirmed by the server).
                restart()
            } else {
                ambiguous(now: now)
                if case .failed = phase { return }
                phase = .checking
            }
        case .uploadConflict:
            // This client id belongs to another file on the server.
            restart()
        case .uploadNotFound:
            // Our session is gone. It may have finished and been purged
            // with a removed moment, so never start over blind.
            phase = .failed(.sessionLost)
            retryAt = nil
        case let .tooManyAttempts(seconds):
            retryAt = now.addingTimeInterval(TimeInterval(min(max(seconds, 1), Int(Self.maxBackoff))))
        case .uploadsClosed: phase = .failed(.uploadsClosed)
        case .eventNotFound, .eventNotHosted: phase = .failed(.eventGone)
        case .accessRequired, .invalidAccess, .guestRequired, .accessUnavailable:
            phase = .failed(.accessLost)
        case .invalidUpload, .invalidRequest: phase = .failed(.refused)
        case .upgradeRequired: phase = .failed(.appTooOld)
        case .uploadsUnavailable: phase = .failed(.unavailable)
        case .nicknameTaken, .momentNotFound, .server, .transport, .rateLimited, .tooManyUploads,
             .storageUnavailable, .unexpectedResponse,
             // Host and join errors; an upload never gets them.
             .invalidCredentials, .hostAuthRequired, .signInUnavailable, .mediaDeleteFailed,
             .planRequired, .noEventsLeft, .testEventDatesFixed, .guestCapReached:
            giveUp()
        }
    }

    /// An answer that didn't finish the upload ("parts missing", "not
    /// open", unknown status): count it per session and back off, giving up
    /// after `maxRounds`. Sent parts don't reset it, or a lying server could
    /// make the app upload the file forever.
    mutating func ambiguous(now: Date) {
        rounds += 1
        if rounds >= Self.maxRounds { return giveUp() }
        retryAt = now.addingTimeInterval(Self.backoff(attempt: rounds))
    }

    /// New parts reached storage: the error back-off starts over.
    mutating func madeProgress() {
        attempts = 0
        retryAt = nil
    }

    /// The server confirmed this id's session is unusable: a new id opens a
    /// fresh session (bounded, so a server that keeps cancelling can't loop).
    mutating func restart() {
        guard restarts < Self.maxRestarts else {
            // The old session is unusable either way; a guest retry starts fresh.
            session = nil
            uploaded = []
            return giveUp()
        }
        restarts += 1
        clientUploadID = UUID()
        session = nil
        uploaded = []
        rounds = 0
        phase = .prepared
    }

    mutating func giveUp() {
        phase = .failed(.gaveUp)
        retryAt = nil
    }

    func sessionRef(for server: UploadSession) -> SessionRef? {
        guard let id = Self.validID(server.id), server.partSize > 0,
              server.partCount == UploadPlan.partCount(size: file.size, partSize: server.partSize)
        else { return nil }
        return SessionRef(id: id, partSize: server.partSize, partCount: server.partCount)
    }

    /// Server ids end up in URL paths and on disk: short and plain only.
    static func validID(_ value: String) -> String? {
        value.count <= 128 && !value.isEmpty
            && value.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-" || $0 == "_" }
            ? value : nil
    }

    static let offlineCodes: Set<URLError.Code> = [
        .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff,
        .callIsActive, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
    ]

    /// 5 s, 10 s, 20 s ... capped at 15 minutes.
    static func backoff(attempt: Int) -> TimeInterval {
        min(maxBackoff, 5 * pow(2, Double(max(0, min(attempt - 1, 20)))))
    }
}

// MARK: - Validated decoding

extension QueuedUpload {
    /// A record read back from disk is checked as strictly as a server
    /// answer: a corrupt or tampered file must not crash the app (in a loop,
    /// on every launch) or point the engine at the wrong bytes.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(Int.self, forKey: .schemaVersion)
        guard version == Self.schemaVersion else {
            throw DecodingError.dataCorruptedError(forKey: .schemaVersion, in: c, debugDescription: "unsupported version")
        }
        schemaVersion = version
        id = try c.decode(UUID.self, forKey: .id)
        eventSlug = try c.decode(String.self, forKey: .eventSlug)
        file = try c.decode(StagedFile.self, forKey: .file)
        caption = try c.decodeIfPresent(String.self, forKey: .caption)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        clientUploadID = try c.decode(UUID.self, forKey: .clientUploadID)
        phase = try c.decode(Phase.self, forKey: .phase)
        session = try c.decodeIfPresent(SessionRef.self, forKey: .session)
        uploaded = try c.decode(Set<Int>.self, forKey: .uploaded)
        attempts = try c.decode(Int.self, forKey: .attempts)
        restarts = try c.decode(Int.self, forKey: .restarts)
        rounds = try c.decode(Int.self, forKey: .rounds)
        retryAt = try c.decodeIfPresent(Date.self, forKey: .retryAt)
        // Optional extras (absent in records saved before thumbnails): a bad
        // one is dropped, never the whole record.
        let thumbnail = try? c.decodeIfPresent(StagedFile.self, forKey: .thumbnail)
        self.thumbnail = thumbnail.flatMap { $0.contentType == Self.thumbnailContentType ? $0 : nil }
        thumbnailSentFor = (try? c.decodeIfPresent(String.self, forKey: .thumbnailSentFor)).flatMap(Self.validID)

        if case let .done(momentID?) = phase, Self.validID(momentID) == nil {
            throw DecodingError.dataCorruptedError(forKey: .phase, in: c, debugDescription: "invalid moment id")
        }
        if session == nil, phase == .finishing || phase == .checking {
            throw DecodingError.dataCorruptedError(forKey: .phase, in: c, debugDescription: "phase needs a session")
        }
        let sessionIsValid: Bool = if let ref = session {
            Self.validID(ref.id) != nil && ref.partCount == UploadPlan.partCount(size: file.size, partSize: ref.partSize)
                && uploaded.allSatisfy { $0 >= 1 && $0 <= ref.partCount }
        } else {
            uploaded.isEmpty
        }
        guard !eventSlug.isEmpty, eventSlug.count <= 200, sessionIsValid,
              (0 ... Self.maxAttempts).contains(attempts), (0 ... Self.maxRestarts).contains(restarts),
              (0 ... Self.maxRounds).contains(rounds)
        else {
            throw DecodingError.dataCorruptedError(forKey: .session, in: c, debugDescription: "invalid upload record")
        }
    }
}
