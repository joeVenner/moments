import Foundation
import MomentsDomain
import OpenAPIRuntime
import OpenAPIURLSession

/// One page of the feed, newest first.
public struct FeedPage: Sendable, Hashable {
    public let moments: [Moment]
    /// Pass as `before` for older moments; nil on the last page.
    public let nextBefore: Int?
    /// Pass as `since` to `feedChanges`.
    public let cursor: Int
    /// Rows this build couldn't read (e.g. a newer media kind): suggest an update.
    public let skippedCount: Int

    public init(moments: [Moment], nextBefore: Int?, cursor: Int, skippedCount: Int = 0) {
        self.moments = moments
        self.nextBefore = nextBefore
        self.cursor = cursor
        self.skippedCount = skippedCount
    }
}

/// Everything that changed after a cursor, oldest first.
public struct FeedChanges: Sendable, Hashable {
    public let upserts: [Moment]
    /// Includes rows this build couldn't read, so stale copies leave the screen.
    public let removed: [String]
    public let cursor: Int
    /// More changes are waiting: call again with `cursor` right away.
    public let hasMore: Bool
    public let skippedCount: Int

    public init(upserts: [Moment], removed: [String], cursor: Int, hasMore: Bool, skippedCount: Int = 0) {
        self.upserts = upserts
        self.removed = removed
        self.cursor = cursor
        self.hasMore = hasMore
        self.skippedCount = skippedCount
    }
}

/// Result of joining an event.
public struct JoinResult: Sendable, Hashable {
    public let participant: Participant
    /// Present only when this request claimed the nickname: store it in the
    /// keychain and send it on later requests as the guest token.
    public let guestToken: String?

    public init(participant: Participant, guestToken: String?) {
        self.participant = participant
        self.guestToken = guestToken
    }
}

/// Per-event secrets for the requests that need them.
public struct EventCredentials: Sendable, Hashable {
    /// Signed grant from the access endpoint (private events only).
    public var accessGrant: String?
    /// Guest token from a previous join.
    public var guestToken: String?

    public init(accessGrant: String? = nil, guestToken: String? = nil) {
        self.accessGrant = accessGrant
        self.guestToken = guestToken
    }
}

/// What screens and stores depend on, so tests can pass a fake.
/// Every method throws `MomentsAPIError` (or `CancellationError`).
public protocol MomentsService: Sendable {
    func event(slug: String, credentials: EventCredentials) async throws -> Event
    func feedPage(slug: String, before: Int?, limit: Int?, reactorID: String?, credentials: EventCredentials) async throws -> FeedPage
    func feedChanges(slug: String, since: Int, limit: Int?, reactorID: String?, credentials: EventCredentials) async throws -> FeedChanges
    func join(slug: String, nickname: String, avatarSeed: String?, credentials: EventCredentials) async throws -> JoinResult
}

/// The app's API client: the generated v1 client plus the version header,
/// typed errors and mapping into MomentsDomain.
public struct MomentsClient: MomentsService {
    private let client: Client
    private let mapper: WireMapper

    public enum ConfigurationError: Error, Equatable {
        /// https only (http to localhost in debug builds), no credentials,
        /// query or fragment.
        case insecureBaseURL
    }

    /// - Parameters:
    ///   - baseURL: the site origin, e.g. `https://moments-hq.com`; `/api/v1` is appended.
    ///   - transport: tests only. The default transport refuses redirects and
    ///     keeps no cookies or cache; a custom one bypasses that hardening.
    public init(baseURL: URL, identity: ClientIdentity, transport: (any ClientTransport)? = nil) throws {
        guard Self.isAllowedBaseURL(baseURL), let mapper = WireMapper(apiBaseURL: baseURL) else {
            throw ConfigurationError.insecureBaseURL
        }
        client = Client(
            serverURL: baseURL.appending(path: "api/v1"),
            transport: transport ?? URLSessionTransport(configuration: .init(session: Self.makeSession())),
            middlewares: [ClientIdentityMiddleware(identity: identity), NonJSONErrorMiddleware()]
        )
        self.mapper = mapper
    }

    static func isAllowedBaseURL(_ url: URL) -> Bool {
        guard url.user() == nil, url.password() == nil, url.query() == nil, url.fragment() == nil,
              let host = url.host(), !host.isEmpty
        else { return false }
        switch url.scheme?.lowercased() {
        case "https": return true
        #if DEBUG
        case "http": return host == "localhost" || host == "127.0.0.1"
        #endif
        default: return false
        }
    }

    /// No cookies (v1 only honours headers), no HTTP cache (responses are
    /// no-store) and no redirects (they would carry our headers elsewhere).
    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 30
        return URLSession(configuration: configuration, delegate: RedirectRefusal(), delegateQueue: nil)
    }

    public func event(slug: String, credentials: EventCredentials = .init()) async throws -> Event {
        try await perform {
            let output = try await client.getEvent(
                path: .init(slug: slug), headers: .init(xEventAccess: credentials.accessGrant)
            )
            switch output {
            case let .ok(response): return try mapper.event(response.body.json.event)
            case let .unauthorized(response): throw Self.error(401, try? response.body.json.code)
            case let .notFound(response): throw Self.error(404, try? response.body.json.code)
            case let .upgradeRequired(response): throw Self.error(426, try? response.body.json.code)
            case let .default(status, response): throw Self.error(status, try? response.body.json.code)
            }
        }
    }

    public func feedPage(
        slug: String, before: Int? = nil, limit: Int? = nil, reactorID: String? = nil,
        credentials: EventCredentials = .init()
    ) async throws -> FeedPage {
        try await perform {
            let output = try await client.getFeed(
                path: .init(slug: slug),
                query: .init(before: before, limit: limit, reactorId: reactorID),
                headers: .init(xEventAccess: credentials.accessGrant)
            )
            switch output {
            case let .ok(response): return mapper.feedPage(try response.body.json)
            case let .badRequest(response): throw Self.error(400, try? response.body.json.code)
            case let .unauthorized(response): throw Self.error(401, try? response.body.json.code)
            case let .notFound(response): throw Self.error(404, try? response.body.json.code)
            case let .upgradeRequired(response): throw Self.error(426, try? response.body.json.code)
            case let .default(status, response): throw Self.error(status, try? response.body.json.code)
            }
        }
    }

    public func feedChanges(
        slug: String, since: Int, limit: Int? = nil, reactorID: String? = nil,
        credentials: EventCredentials = .init()
    ) async throws -> FeedChanges {
        try await perform {
            let output = try await client.getFeedChanges(
                path: .init(slug: slug),
                query: .init(since: since, limit: limit, reactorId: reactorID),
                headers: .init(xEventAccess: credentials.accessGrant)
            )
            switch output {
            case let .ok(response): return mapper.feedChanges(try response.body.json)
            case let .badRequest(response): throw Self.error(400, try? response.body.json.code)
            case let .unauthorized(response): throw Self.error(401, try? response.body.json.code)
            case let .notFound(response): throw Self.error(404, try? response.body.json.code)
            case let .upgradeRequired(response): throw Self.error(426, try? response.body.json.code)
            case let .default(status, response): throw Self.error(status, try? response.body.json.code)
            }
        }
    }

    public func join(
        slug: String, nickname: String, avatarSeed: String? = nil, credentials: EventCredentials = .init()
    ) async throws -> JoinResult {
        try await perform {
            let output = try await client.joinEvent(
                path: .init(slug: slug),
                headers: .init(xEventAccess: credentials.accessGrant, xGuestToken: credentials.guestToken),
                body: .json(.init(nickname: nickname, avatarSeed: avatarSeed))
            )
            switch output {
            case let .ok(response):
                let body = try response.body.json
                return JoinResult(participant: try mapper.participant(body.participant), guestToken: body.guestToken)
            case let .badRequest(response): throw Self.error(400, try? response.body.json.code)
            case let .unauthorized(response): throw Self.error(401, try? response.body.json.code)
            case let .notFound(response): throw Self.error(404, try? response.body.json.code)
            case let .conflict(response): throw Self.error(409, try? response.body.json.code)
            case let .upgradeRequired(response): throw Self.error(426, try? response.body.json.code)
            case let .default(status, response): throw Self.error(status, try? response.body.json.code)
            }
        }
    }

    /// Runs one call and converts every failure to `MomentsAPIError`, so no
    /// runtime error (whose description prints request headers) escapes.
    private func perform<T>(_ operation: () async throws -> T) async throws -> T {
        do {
            return try await operation()
        } catch {
            throw Self.sanitized(error)
        }
    }

    static func sanitized(_ error: any Error) -> any Error {
        let underlying = (error as? ClientError)?.underlyingError ?? error
        switch underlying {
        case let apiError as MomentsAPIError: return apiError
        case is CancellationError: return CancellationError()
        case let urlError as URLError where urlError.code == .cancelled: return CancellationError()
        case let urlError as URLError: return MomentsAPIError.transport(urlError.code)
        default: return MomentsAPIError.unexpectedResponse
        }
    }

    /// Maps a status and the server's stable `code` to a typed error.
    static func error(_ status: Int, _ code: String?) -> MomentsAPIError {
        switch (status, code) {
        case (401, _): .accessRequired
        case (404, "event_not_found"): .eventNotFound
        case (426, _): .upgradeRequired
        case (409, "nickname_taken"): .nicknameTaken
        case (400, _), (415, _): .invalidRequest
        default: .server(status: status, code: code)
        }
    }
}

/// Refuses every redirect: the 3xx is returned as-is (and surfaces as
/// `.server(status:)`), so custom headers never follow it to another host.
final class RedirectRefusal: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}
