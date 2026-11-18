import Foundation

/// Leaving an event, separate from `MomentsService` like `UploadService`.
public protocol LeaveService: Sendable {
    /// One step of "leave and delete what I shared from the app". Returns
    /// true once everything is deleted and the guest token is revoked;
    /// false means call again with the same credentials. Throws
    /// `.guestRequired` when the token no longer works (already left).
    func leaveEvent(slug: String, credentials: EventCredentials) async throws -> Bool
}

extension MomentsClient: LeaveService {
    public func leaveEvent(slug: String, credentials: EventCredentials = .init()) async throws -> Bool {
        try await perform {
            let output = try await client.leaveEvent(
                path: .init(slug: slug),
                headers: .init(xEventAccess: credentials.accessGrant, xGuestToken: credentials.guestToken)
            )
            switch output {
            case let .ok(response): return try response.body.json.done
            case let .unauthorized(response): throw Self.error(401, try? response.body.json.code)
            case let .forbidden(response): throw Self.error(403, try? response.body.json.code)
            case let .notFound(response): throw Self.error(404, try? response.body.json.code)
            case let .upgradeRequired(response): throw Self.error(426, try? response.body.json.code)
            case let .tooManyRequests(response): throw Self.error(429, try? response.body.json.code)
            case let .badGateway(response): throw Self.error(502, try? response.body.json.code)
            case let .default(status, response): throw Self.error(status, try? response.body.json.code)
            }
        }
    }
}
