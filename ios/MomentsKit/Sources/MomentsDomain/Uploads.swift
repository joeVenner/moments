import Foundation

/// A server-side upload session (one queued photo or video). The app sends
/// the file in fixed-size parts straight to storage, then asks the server
/// to finish; the server checks the parts and creates the moment.
public struct UploadSession: Sendable, Hashable, Identifiable {
    public enum Status: Sendable, Hashable {
        case open, completed, aborted
        /// A status a newer server added; treat as not open.
        case unknown(String)

        public init(rawValue: String) {
            switch rawValue {
            case "open": self = .open
            case "completed": self = .completed
            case "aborted": self = .aborted
            default: self = .unknown(rawValue)
            }
        }
    }

    public let id: String
    /// The id the app chose; a retry with it returns this same session.
    public let clientUploadID: UUID
    public let status: Status
    public let contentType: String
    public let size: Int64
    public let partSize: Int64
    public let partCount: Int
    public let createdAt: Date
    public let completedAt: Date?
    /// The moment this upload became, once completed (nil if since deleted).
    public let momentID: String?

    public init(
        id: String, clientUploadID: UUID, status: Status, contentType: String, size: Int64, partSize: Int64,
        partCount: Int, createdAt: Date, completedAt: Date? = nil, momentID: String? = nil
    ) {
        self.id = id
        self.clientUploadID = clientUploadID
        self.status = status
        self.contentType = contentType
        self.size = size
        self.partSize = partSize
        self.partCount = partCount
        self.createdAt = createdAt
        self.completedAt = completedAt
        self.momentID = momentID
    }
}

/// What the app asks for when it opens a session.
public struct NewUpload: Sendable, Hashable {
    /// Stable per queued item, so a retry after a lost response is harmless.
    public let clientUploadID: UUID
    public let contentType: String
    public let size: Int64
    public let caption: String?
    /// Only used to build the storage key's readable suffix.
    public let filename: String?

    public init(clientUploadID: UUID, contentType: String, size: Int64, caption: String? = nil, filename: String? = nil) {
        self.clientUploadID = clientUploadID
        self.contentType = contentType
        self.size = size
        self.caption = caption
        self.filename = filename
    }
}

/// A session plus the part numbers storage already holds.
public struct UploadProgress: Sendable, Hashable {
    public let session: UploadSession
    public let uploadedParts: Set<Int>

    public init(session: UploadSession, uploadedParts: Set<Int>) {
        self.session = session
        self.uploadedParts = uploadedParts
    }

    /// Parts still to send; none unless the session is open (the server
    /// lists no parts for a finished or cancelled one).
    public var missingParts: [Int] {
        guard session.status == .open else { return [] }
        return UploadPlan.missingParts(partCount: session.partCount, uploaded: uploadedParts)
    }
}

/// Presigned part URLs, all valid until `expiresAt`. Each URL is a write
/// credential for hours, so the batch never prints them (see the extension).
public struct PartURLBatch: Sendable, Hashable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let expiresAt: Date
    /// Part number → presigned PUT URL (https only).
    public let urls: [Int: URL]

    public init(expiresAt: Date, urls: [Int: URL]) {
        self.expiresAt = expiresAt
        self.urls = urls
    }
}

/// Why the server refused an upload's bytes.
public enum RejectReason: RawRepresentable, Sendable, Hashable {
    /// A part had the wrong length (often a resume bug: prepare the file anew).
    case partSizeMismatch
    /// The assembled file's size or type differs from the session.
    case objectMismatch
    /// The file's first bytes aren't the declared type.
    case signatureMismatch
    /// A reason a newer server added.
    case unknown(String)

    /// The server's string for this reason.
    public var rawValue: String {
        switch self {
        case .partSizeMismatch: "part_size_mismatch"
        case .objectMismatch: "object_mismatch"
        case .signatureMismatch: "signature_mismatch"
        case let .unknown(value): value
        }
    }

    public init(rawValue: String) {
        switch rawValue {
        case "part_size_mismatch": self = .partSizeMismatch
        case "object_mismatch": self = .objectMismatch
        case "signature_mismatch": self = .signatureMismatch
        default: self = .unknown(rawValue)
        }
    }
}

/// The server's answer to "finish this upload".
public enum CompleteOutcome: Sendable, Hashable {
    /// Done; `session.momentID` is the new moment.
    case completed(UploadSession)
    /// Some parts are missing: send the others, then ask again.
    case incomplete(uploadedParts: Set<Int>)
    /// The bytes didn't match what was declared; the session is gone. Queue
    /// the item again only after preparing the file anew.
    case rejected(RejectReason)
    /// Cancelled (by the guest or a cleanup), or its moment was since deleted.
    case notOpen
}

/// Pure arithmetic for splitting a file into the session's parts. Values
/// come from the server, so nothing here traps: bad input gives nil or empty.
public enum UploadPlan {
    /// Storage's limit on parts per upload; more means a bad session.
    public static let maxParts = 10_000

    /// Parts for a file of `size` bytes (at least one, as the server counts),
    /// or nil for negative sizes, a non-positive part size or over `maxParts`.
    public static func partCount(size: Int64, partSize: Int64) -> Int? {
        guard size >= 0, partSize > 0 else { return nil }
        let (whole, rest) = size.quotientAndRemainder(dividingBy: partSize)
        let count = max(1, whole + (rest > 0 ? 1 : 0))
        return count <= Int64(maxParts) ? Int(count) : nil
    }

    /// The byte range of part `number` (1-based), or nil when out of range.
    /// Every part is `partSize` long except the last, which holds the rest;
    /// the server rejects any other length.
    public static func byteRange(part number: Int, size: Int64, partSize: Int64) -> Range<Int64>? {
        guard let count = partCount(size: size, partSize: partSize), (1...count).contains(number) else { return nil }
        // No overflow: start < size because number ≤ count.
        let start = Int64(number - 1) * partSize
        return start ..< min(size, start + min(partSize, size - start))
    }

    /// Part numbers still to send, ascending (numbers outside the session ignored).
    public static func missingParts(partCount: Int, uploaded: Set<Int>) -> [Int] {
        guard (1...maxParts).contains(partCount) else { return [] }
        return (1...partCount).filter { !uploaded.contains($0) }
    }

    /// Whether the server's session describes the same file the app holds
    /// (same size and type, and a part count that matches the part size).
    /// Check this before reading any bytes for the session.
    public static func matches(_ session: UploadSession, size: Int64, contentType: String) -> Bool {
        session.size == size
            && session.contentType.lowercased() == contentType.lowercased()
            && session.partCount == partCount(size: size, partSize: session.partSize)
    }
}

// Redacted: the URLs carry presigned write credentials.
public extension PartURLBatch {
    var description: String { "PartURLBatch(parts: \(urls.count), redacted, expiresAt: \(expiresAt))" }
    var debugDescription: String { description }
    var customMirror: Mirror { Mirror(self, children: [:]) }
}
