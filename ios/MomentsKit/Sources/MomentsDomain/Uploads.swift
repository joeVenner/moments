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
    public let clientUploadID: String
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
        id: String, clientUploadID: String, status: Status, contentType: String, size: Int64, partSize: Int64,
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
}

/// Presigned part URLs, all valid until `expiresAt`.
public struct PartURLBatch: Sendable, Hashable {
    public let expiresAt: Date
    /// Part number → presigned PUT URL (https only).
    public let urls: [Int: URL]

    public init(expiresAt: Date, urls: [Int: URL]) {
        self.expiresAt = expiresAt
        self.urls = urls
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
    case rejected(reason: String)
    /// Cancelled (by the guest or a cleanup), or its moment was since deleted.
    case notOpen
}

/// Pure arithmetic for splitting a file into the session's parts.
public enum UploadPlan {
    /// Parts for a file of `size` bytes (at least one, as the server counts).
    public static func partCount(size: Int64, partSize: Int64) -> Int {
        precondition(size >= 0 && partSize > 0, "invalid sizes")
        return max(1, Int((size + partSize - 1) / partSize))
    }

    /// The byte range of part `number` (1-based). Every part is `partSize`
    /// long except the last, which holds the rest; the server rejects any
    /// other length.
    public static func byteRange(part number: Int, size: Int64, partSize: Int64) -> Range<Int64> {
        let count = partCount(size: size, partSize: partSize)
        precondition((1...count).contains(number), "part out of range")
        let start = Int64(number - 1) * partSize
        return start ..< min(size, start + partSize)
    }

    /// Part numbers still to send, ascending.
    public static func missingParts(partCount: Int, uploaded: Set<Int>) -> [Int] {
        guard partCount > 0 else { return [] }
        return (1...partCount).filter { !uploaded.contains($0) }
    }

    /// Whether the server's session describes the same file the app holds
    /// (same size and type, and a part count that matches the part size).
    public static func matches(_ session: UploadSession, size: Int64, contentType: String) -> Bool {
        session.size == size
            && session.contentType.lowercased() == contentType.lowercased()
            && session.partSize > 0
            && session.partCount == partCount(size: size, partSize: session.partSize)
    }
}
