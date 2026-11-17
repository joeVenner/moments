import Foundation
import HTTPTypes
import OpenAPIRuntime

/// The `X-Client: ios/<version>(<build>)` value the server uses to send
/// 426 to builds below its minimum.
///
/// The server ignores a header that doesn't match its pattern (and then never
/// sends 426), so values are normalised here: version to 1-3 numeric parts,
/// build to 1-9 digits.
public struct ClientIdentity: Sendable, Hashable {
    public let version: String
    public let build: String

    public init(version: String, build: String) {
        self.version = Self.normalizedVersion(version)
        self.build = Self.normalizedBuild(build)
    }

    /// From the app's Info.plist (`CFBundleShortVersionString`, `CFBundleVersion`).
    public static func fromBundle(_ bundle: Bundle = .main) -> ClientIdentity {
        ClientIdentity(
            version: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
            build: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        )
    }

    public var headerValue: String { "ios/\(version)(\(build))" }

    /// "1.2.0-beta" → "1.2.0"; anything unreadable → "0".
    static func normalizedVersion(_ raw: String) -> String {
        let parts = raw.prefix { $0.isASCII && ($0.isNumber || $0 == ".") }
            .split(separator: ".", omittingEmptySubsequences: false)
            .prefix(3)
        guard !parts.isEmpty, parts.allSatisfy({ (1...4).contains($0.count) }) else { return "0" }
        return parts.joined(separator: ".")
    }

    /// Builds must be plain integers (set CURRENT_PROJECT_VERSION that way).
    static func normalizedBuild(_ raw: String) -> String {
        guard (1...9).contains(raw.count), raw.allSatisfy({ $0.isASCII && $0.isNumber }) else {
            assertionFailure("CFBundleVersion must be 1-9 digits, got \(raw)")
            return "0"
        }
        return raw
    }
}

/// Adds `X-Client` to every request.
struct ClientIdentityMiddleware: ClientMiddleware {
    static let headerName = HTTPField.Name("X-Client")!
    let identity: ClientIdentity

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        request.headerFields[Self.headerName] = identity.headerValue
        return try await next(request, body, baseURL)
    }
}

/// Turns an error response that isn't JSON (a proxy's HTML 502, a captive
/// portal) into a typed error that keeps its status. Without it the generated
/// client fails to decode the body and the status is lost.
struct NonJSONErrorMiddleware: ClientMiddleware {
    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        let (response, responseBody) = try await next(request, body, baseURL)
        let contentType = response.headerFields[.contentType]?.lowercased() ?? ""
        if response.status.kind != .successful, !contentType.hasPrefix("application/json") {
            throw MomentsClient.error(response.status.code, nil)
        }
        return (response, responseBody)
    }
}
