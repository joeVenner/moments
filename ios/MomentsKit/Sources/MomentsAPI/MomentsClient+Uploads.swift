import Foundation
import MomentsDomain

/// The upload calls, separate from `MomentsService` so screens that never
/// upload (and their test fakes) don't depend on them. All need the guest
/// token in `credentials`; every method throws `MomentsAPIError` (or
/// `CancellationError`).
public protocol UploadService: Sendable {
    /// Opens a session, or returns the existing one for this client upload id.
    func startUpload(_ upload: NewUpload, slug: String, credentials: EventCredentials) async throws -> UploadSession
    /// The session and the parts storage already holds.
    func uploadProgress(slug: String, uploadID: String, credentials: EventCredentials) async throws -> UploadProgress
    /// Presigned part URLs: the given parts, or all of them when nil.
    func partURLs(slug: String, uploadID: String, parts: [Int]?, credentials: EventCredentials) async throws -> PartURLBatch
    /// Asks the server to finish the session. Safe to repeat.
    func completeUpload(slug: String, uploadID: String, credentials: EventCredentials) async throws -> CompleteOutcome
    /// Cancels the session (repeating is harmless). Throws `.uploadNotOpen` once it completed: the moment exists.
    func abortUpload(slug: String, uploadID: String, credentials: EventCredentials) async throws -> UploadSession
}

extension MomentsClient: UploadService {
    public func startUpload(
        _ upload: NewUpload, slug: String, credentials: EventCredentials = .init()
    ) async throws -> UploadSession {
        guard upload.size > 0 else { throw MomentsAPIError.invalidUpload }
        return try await perform {
            let output = try await client.startUpload(
                path: .init(slug: slug),
                headers: .init(xEventAccess: credentials.accessGrant, xGuestToken: credentials.guestToken),
                body: .json(.init(
                    clientUploadId: upload.clientUploadID.uuidString.lowercased(),
                    contentType: upload.contentType,
                    size: Int(upload.size),
                    caption: upload.caption,
                    filename: upload.filename
                ))
            )
            switch output {
            case let .ok(response): return try mapper.uploadSession(response.body.json)
            case let .created(response): return try mapper.uploadSession(response.body.json)
            case let .badRequest(response): throw Self.error(400, try? response.body.json.code)
            case let .unauthorized(response): throw Self.error(401, try? response.body.json.code)
            case let .forbidden(response): throw Self.error(403, try? response.body.json.code)
            case let .notFound(response): throw Self.error(404, try? response.body.json.code)
            case let .conflict(response): throw Self.error(409, try? response.body.json.code)
            case let .upgradeRequired(response): throw Self.error(426, try? response.body.json.code)
            case let .tooManyRequests(response): throw Self.error(429, try? response.body.json.code)
            case let .notImplemented(response): throw Self.error(501, try? response.body.json.code)
            case let .badGateway(response): throw Self.error(502, try? response.body.json.code)
            case let .default(status, response): throw Self.error(status, try? response.body.json.code)
            }
        }
    }

    public func uploadProgress(
        slug: String, uploadID: String, credentials: EventCredentials = .init()
    ) async throws -> UploadProgress {
        try await perform {
            let output = try await client.getUpload(
                path: .init(slug: slug, id: uploadID),
                headers: .init(xEventAccess: credentials.accessGrant, xGuestToken: credentials.guestToken)
            )
            switch output {
            case let .ok(response):
                let body = try response.body.json
                let session = try mapper.uploadSession(body.upload)
                // Only parts of this session count.
                let uploaded = Set(body.uploadedParts.filter { (1...session.partCount).contains($0) })
                return UploadProgress(session: session, uploadedParts: uploaded)
            case let .unauthorized(response): throw Self.error(401, try? response.body.json.code)
            case let .forbidden(response): throw Self.error(403, try? response.body.json.code)
            case let .notFound(response): throw Self.error(404, try? response.body.json.code)
            case let .upgradeRequired(response): throw Self.error(426, try? response.body.json.code)
            case let .tooManyRequests(response): throw Self.error(429, try? response.body.json.code)
            case let .notImplemented(response): throw Self.error(501, try? response.body.json.code)
            case let .badGateway(response): throw Self.error(502, try? response.body.json.code)
            case let .default(status, response): throw Self.error(status, try? response.body.json.code)
            }
        }
    }

    public func partURLs(
        slug: String, uploadID: String, parts: [Int]? = nil, credentials: EventCredentials = .init()
    ) async throws -> PartURLBatch {
        // The server refuses an empty list (it would mean "nothing"), so don't send one.
        if let parts, parts.isEmpty { throw MomentsAPIError.invalidRequest }
        return try await perform {
            let output = try await client.getPartUrls(
                path: .init(slug: slug, id: uploadID),
                headers: .init(xEventAccess: credentials.accessGrant, xGuestToken: credentials.guestToken),
                body: .json(.init(partNumbers: parts))
            )
            switch output {
            case let .ok(response): return try mapper.partURLs(response.body.json, requested: parts)
            case let .badRequest(response): throw Self.error(400, try? response.body.json.code)
            case let .unauthorized(response): throw Self.error(401, try? response.body.json.code)
            case let .forbidden(response): throw Self.error(403, try? response.body.json.code)
            case let .notFound(response): throw Self.error(404, try? response.body.json.code)
            case let .conflict(response): throw Self.error(409, try? response.body.json.code)
            case let .upgradeRequired(response): throw Self.error(426, try? response.body.json.code)
            case let .tooManyRequests(response): throw Self.error(429, try? response.body.json.code)
            case let .notImplemented(response): throw Self.error(501, try? response.body.json.code)
            case let .badGateway(response): throw Self.error(502, try? response.body.json.code)
            case let .default(status, response): throw Self.error(status, try? response.body.json.code)
            }
        }
    }

    public func completeUpload(
        slug: String, uploadID: String, credentials: EventCredentials = .init()
    ) async throws -> CompleteOutcome {
        try await perform {
            let output = try await client.completeUpload(
                path: .init(slug: slug, id: uploadID),
                headers: .init(xEventAccess: credentials.accessGrant, xGuestToken: credentials.guestToken)
            )
            switch output {
            case let .ok(response): return .completed(try mapper.uploadSession(response.body.json))
            case let .conflict(response):
                let body = try? response.body.json
                switch body?.code {
                case "upload_incomplete":
                    let parts = (body?.uploadedParts ?? []).filter { (1...UploadPlan.maxParts).contains($0) }
                    return .incomplete(uploadedParts: Set(parts))
                case "upload_not_open": return .notOpen
                default: throw Self.error(409, body?.code)
                }
            case let .unprocessableContent(response): return .rejected(RejectReason(rawValue: try response.body.json.reason))
            case let .unauthorized(response): throw Self.error(401, try? response.body.json.code)
            case let .forbidden(response): throw Self.error(403, try? response.body.json.code)
            case let .notFound(response): throw Self.error(404, try? response.body.json.code)
            case let .upgradeRequired(response): throw Self.error(426, try? response.body.json.code)
            case let .tooManyRequests(response): throw Self.error(429, try? response.body.json.code)
            case let .notImplemented(response): throw Self.error(501, try? response.body.json.code)
            case let .badGateway(response): throw Self.error(502, try? response.body.json.code)
            case let .default(status, response): throw Self.error(status, try? response.body.json.code)
            }
        }
    }

    public func abortUpload(
        slug: String, uploadID: String, credentials: EventCredentials = .init()
    ) async throws -> UploadSession {
        try await perform {
            let output = try await client.abortUpload(
                path: .init(slug: slug, id: uploadID),
                headers: .init(xEventAccess: credentials.accessGrant, xGuestToken: credentials.guestToken)
            )
            switch output {
            case let .ok(response): return try mapper.uploadSession(response.body.json)
            case let .unauthorized(response): throw Self.error(401, try? response.body.json.code)
            case let .forbidden(response): throw Self.error(403, try? response.body.json.code)
            case let .notFound(response): throw Self.error(404, try? response.body.json.code)
            case let .conflict(response): throw Self.error(409, try? response.body.json.code)
            case let .upgradeRequired(response): throw Self.error(426, try? response.body.json.code)
            case let .tooManyRequests(response): throw Self.error(429, try? response.body.json.code)
            case let .notImplemented(response): throw Self.error(501, try? response.body.json.code)
            case let .badGateway(response): throw Self.error(502, try? response.body.json.code)
            case let .default(status, response): throw Self.error(status, try? response.body.json.code)
            }
        }
    }
}

extension WireMapper {
    func uploadSession(_ wire: Components.Schemas.UploadSession) throws(MomentsAPIError) -> UploadSession {
        // The planner trusts these to agree, so a session that doesn't is refused.
        guard let createdAt = ServerDate.parse(wire.createdAt), let clientUploadID = UUID(uuidString: wire.clientUploadId),
              wire.partCount == UploadPlan.partCount(size: Int64(wire.size), partSize: Int64(wire.partSize))
        else { throw .unexpectedResponse }
        var completedAt: Date?
        if let value = wire.completedAt {
            guard let parsed = ServerDate.parse(value) else { throw .unexpectedResponse }
            completedAt = parsed
        }
        return UploadSession(
            id: wire.id, clientUploadID: clientUploadID, status: .init(rawValue: wire.status),
            contentType: wire.contentType, size: Int64(wire.size), partSize: Int64(wire.partSize),
            partCount: wire.partCount, createdAt: createdAt, completedAt: completedAt, momentID: wire.momentId
        )
    }

    /// Part URLs go straight to storage with the file's bytes, so only plain
    /// https URLs (no userinfo) are accepted, one per requested part (any
    /// part when `requested` is nil); one bad entry fails the batch.
    func partURLs(_ wire: Components.Schemas.PartUrls, requested: [Int]?) throws(MomentsAPIError) -> PartURLBatch {
        guard let expiresAt = ServerDate.parse(wire.expiresAt) else { throw .unexpectedResponse }
        let wanted = requested.map(Set.init)
        var urls: [Int: URL] = [:]
        for part in wire.parts {
            guard (1...UploadPlan.maxParts).contains(part.partNumber), urls[part.partNumber] == nil,
                  wanted?.contains(part.partNumber) ?? true,
                  let url = URL(string: part.url), url.scheme?.lowercased() == "https",
                  url.host() != nil, url.user() == nil, url.password() == nil
            else { throw .unexpectedResponse }
            urls[part.partNumber] = url
        }
        if let wanted, Set(urls.keys) != wanted { throw .unexpectedResponse }
        return PartURLBatch(expiresAt: expiresAt, urls: urls)
    }
}
