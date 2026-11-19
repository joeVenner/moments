import Foundation
import HTTPTypes
import MomentsDomain
import OpenAPIRuntime

/// A new host session. Keep `token` in the keychain; it is returned only once.
public struct HostSession: Sendable, Hashable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let token: String
    /// Who signed in: `operator` (the admin login) for now.
    public let subject: String
    public let expiresAt: Date

    public init(token: String, subject: String, expiresAt: Date) {
        self.token = token
        self.subject = subject
        self.expiresAt = expiresAt
    }

    public var description: String { "HostSession(redacted, subject: \(subject), expiresAt: \(expiresAt))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// The host screens' calls. Every method throws `MomentsAPIError` (or
/// `CancellationError`); `.hostAuthRequired` means the token is dead.
public protocol HostService: Sendable {
    /// `.invalidCredentials`, `.tooManyAttempts` (locked: wait),
    /// `.signInUnavailable` are the expected failures.
    func signIn(username: String, password: String) async throws -> HostSession
    /// When the session ends; `.hostAuthRequired` when it already has.
    func hostSessionExpiry(token: String) async throws -> Date
    /// The token stops working on the server.
    func signOut(token: String) async throws
    func adminEvents(token: String) async throws -> AdminEventList
    /// `.eventNotFound` when the event is gone.
    func adminEvent(token: String, id: String) async throws -> AdminEventDetail
}

extension MomentsClient: HostService {
    /// The lockout's window: the server sends no machine-readable wait in the body.
    static let hostSignInRetryAfterSeconds = 15 * 60

    public func signIn(username: String, password: String) async throws -> HostSession {
        guard !username.isEmpty, !password.isEmpty else { throw MomentsAPIError.invalidCredentials }
        return try await perform {
            let output = try await client.signIn(body: .json(.init(username: username, password: password)))
            switch output {
            case let .created(response):
                let body = try response.body.json
                // HostSignInResponse = HostSession (value1) + the token (value2).
                guard let expiresAt = ServerDate.parse(body.value1.expiresAt), !body.value2.token.isEmpty else {
                    throw MomentsAPIError.unexpectedResponse
                }
                return HostSession(token: body.value2.token, subject: body.value1.subject, expiresAt: expiresAt)
            case .unauthorized: throw MomentsAPIError.invalidCredentials
            case .tooManyRequests:
                throw MomentsAPIError.tooManyAttempts(retryAfterSeconds: Self.hostSignInRetryAfterSeconds)
            case let .badRequest(response): throw Self.hostError(400, try? response.body.json.code)
            case let .upgradeRequired(response): throw Self.hostError(426, try? response.body.json.code)
            case let .serviceUnavailable(response): throw Self.hostError(503, try? response.body.json.code)
            case let .default(status, response): throw Self.hostError(status, try? response.body.json.code)
            }
        }
    }

    public func hostSessionExpiry(token: String) async throws -> Date {
        try await withHostToken(token) {
            let output = try await client.getHostSession()
            switch output {
            case let .ok(response):
                guard let expiresAt = ServerDate.parse(try response.body.json.expiresAt) else {
                    throw MomentsAPIError.unexpectedResponse
                }
                return expiresAt
            case let .unauthorized(response): throw Self.hostError(401, try? response.body.json.code)
            case let .upgradeRequired(response): throw Self.hostError(426, try? response.body.json.code)
            case let .default(status, response): throw Self.hostError(status, try? response.body.json.code)
            }
        }
    }

    public func signOut(token: String) async throws {
        try await withHostToken(token) {
            let output = try await client.signOut()
            switch output {
            case .noContent: return
            case let .unauthorized(response): throw Self.hostError(401, try? response.body.json.code)
            case let .upgradeRequired(response): throw Self.hostError(426, try? response.body.json.code)
            case let .default(status, response): throw Self.hostError(status, try? response.body.json.code)
            }
        }
    }

    public func adminEvents(token: String) async throws -> AdminEventList {
        try await withHostToken(token) {
            let output = try await client.listAdminEvents()
            switch output {
            case let .ok(response):
                let body = try response.body.json
                // A row this build can't read is skipped, not fatal for the list.
                let events = body.events.compactMap { try? mapper.adminEvent($0) }
                return AdminEventList(events: events, isTruncated: body.truncated)
            case let .unauthorized(response): throw Self.hostError(401, try? response.body.json.code)
            case let .upgradeRequired(response): throw Self.hostError(426, try? response.body.json.code)
            case let .default(status, response): throw Self.hostError(status, try? response.body.json.code)
            }
        }
    }

    public func adminEvent(token: String, id: String) async throws -> AdminEventDetail {
        guard !id.isEmpty, id.count <= 100 else { throw MomentsAPIError.eventNotFound }
        return try await withHostToken(token) {
            let output = try await client.getAdminEvent(path: .init(id: id))
            switch output {
            case let .ok(response):
                return try mapper.adminEventDetail(try response.body.json)
            case let .unauthorized(response): throw Self.hostError(401, try? response.body.json.code)
            case let .notFound(response): throw Self.hostError(404, try? response.body.json.code)
            case let .upgradeRequired(response): throw Self.hostError(426, try? response.body.json.code)
            case let .default(status, response): throw Self.hostError(status, try? response.body.json.code)
            }
        }
    }

    /// Runs one host call with the bearer token attached by `HostAuthMiddleware`.
    private func withHostToken<T: Sendable>(_ token: String, _ operation: () async throws -> T) async throws -> T {
        guard !token.isEmpty else { throw MomentsAPIError.hostAuthRequired }
        return try await perform {
            try await HostAuthMiddleware.$token.withValue(token, operation: operation)
        }
    }

    /// Like `error(_:_:)`, but a 401 on a host route never means "event access".
    static func hostError(_ status: Int, _ code: String?) -> MomentsAPIError {
        switch (status, code) {
        case (401, "invalid_credentials"): .invalidCredentials
        case (401, _): .hostAuthRequired
        case (503, "sign_in_unavailable"): .signInUnavailable
        default: error(status, code)
        }
    }
}

/// Adds `Authorization: Bearer` to the host operations only, from a task-local
/// set by `withHostToken`, so the token can never ride on a guest request.
struct HostAuthMiddleware: ClientMiddleware {
    @TaskLocal static var token: String?
    static let hostOperations: Set<String> = ["getHostSession", "signOut", "listAdminEvents", "getAdminEvent"]

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        guard Self.hostOperations.contains(operationID), let token = Self.token else {
            return try await next(request, body, baseURL)
        }
        var request = request
        request.headerFields[.authorization] = "Bearer \(token)"
        return try await next(request, body, baseURL)
    }
}

extension WireMapper {
    func adminEvent(_ wire: Components.Schemas.AdminEvent) throws(MomentsAPIError) -> AdminEvent {
        // AdminEvent = Event (value1) + the two counts (value2).
        AdminEvent(
            event: try event(wire.value1),
            momentCount: max(0, wire.value2.momentCount),
            participantCount: max(0, wire.value2.participantCount)
        )
    }

    /// Share links must be on our own origin, like media: the app puts them in
    /// a QR code and the share sheet, so a link elsewhere is refused outright.
    func adminEventDetail(_ wire: Components.Schemas.AdminEventDetail) throws(MomentsAPIError) -> AdminEventDetail {
        guard let eventURL = resolveSameOrigin(wire.share.eventUrl) else { throw .unexpectedResponse }
        var inviteURL: URL?
        if let invite = wire.share.inviteUrl {
            guard let url = resolveSameOrigin(invite) else { throw .unexpectedResponse }
            inviteURL = url
        }
        let summary = wire.analytics.summary
        return AdminEventDetail(
            summary: try adminEvent(wire.event),
            share: EventShareLinks(eventURL: eventURL, inviteURL: inviteURL),
            analytics: EventAnalytics(
                totalMoments: max(0, summary.totalMoments),
                hiddenMoments: max(0, summary.hiddenMoments),
                photos: max(0, summary.photos),
                videos: max(0, summary.videos),
                storageBytes: max(0, summary.storageBytes),
                participants: max(0, summary.participants),
                reactions: max(0, summary.reactions),
                activity: wire.analytics.activity.map { EventAnalytics.DayCount(day: $0.day, count: max(0, $0.count)) }
            )
        )
    }
}
