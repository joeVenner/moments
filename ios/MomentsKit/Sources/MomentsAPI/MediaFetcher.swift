import Foundation

/// Downloads feed images. Private events' `/media` URLs need the access
/// grant, which can only travel as a header, so image views can't use
/// `AsyncImage`. The grant is attached only to our own origin, never to
/// Cloudflare Stream or anything else.
public struct MediaFetcher: Sendable {
    /// Loads a request, giving up once the body passes `maxBytes`.
    public typealias Load = @Sendable (_ request: URLRequest, _ maxBytes: Int) async throws -> (Data, URLResponse)

    /// Larger bodies are refused (thumbnails are far smaller; originals of
    /// big photos still fit).
    public static let maxBytes = 40 * 1024 * 1024

    private let origin: (scheme: String, host: String, port: Int?)
    private let identity: ClientIdentity
    private let load: Load

    /// - Parameter load: tests only; the default uses the API client's
    ///   hardened session (no redirects, cookies or cache).
    public init(baseURL: URL, identity: ClientIdentity, load: Load? = nil) throws {
        guard MomentsClient.isAllowedBaseURL(baseURL),
              let scheme = baseURL.scheme?.lowercased(), let host = baseURL.host()?.lowercased()
        else { throw MomentsClient.ConfigurationError.insecureBaseURL }
        origin = (scheme, host, baseURL.port)
        self.identity = identity
        if let load {
            self.load = load
        } else {
            let session = MomentsClient.makeSession()
            self.load = { request, maxBytes in try await Self.boundedLoad(session, request, maxBytes: maxBytes) }
        }
    }

    /// Whether `url` is on the API's origin (and so may carry the grant).
    public func isOwnOrigin(_ url: URL) -> Bool {
        url.scheme?.lowercased() == origin.scheme && url.host()?.lowercased() == origin.host
            && url.port == origin.port && url.user() == nil && url.password() == nil
    }

    /// The bytes at `url`. Only https URLs (or our own origin) are fetched.
    public func data(for url: URL, accessGrant: String?, maxBytes: Int = MediaFetcher.maxBytes) async throws -> Data {
        let isOwn = isOwnOrigin(url)
        guard isOwn || url.scheme?.lowercased() == "https" else { throw MomentsAPIError.invalidRequest }
        var request = URLRequest(url: url)
        request.setValue(identity.headerValue, forHTTPHeaderField: "X-Client")
        if isOwn, let accessGrant { request.setValue(accessGrant, forHTTPHeaderField: "X-Event-Access") }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await load(request, maxBytes)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as MomentsAPIError {
            throw error
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            throw MomentsAPIError.transport(error.code)
        } catch {
            throw MomentsAPIError.transport(nil)
        }
        guard let http = response as? HTTPURLResponse else { throw MomentsAPIError.unexpectedResponse }
        switch http.statusCode {
        case 200..<300:
            guard data.count <= maxBytes else { throw MomentsAPIError.unexpectedResponse }
            return data
        case 401, 403: throw MomentsAPIError.accessRequired
        case 404: throw MomentsAPIError.eventNotFound
        default: throw MomentsAPIError.server(status: http.statusCode, code: nil)
        }
    }

    /// Streams the body and stops as soon as it passes `maxBytes`, so an
    /// oversized response is never held in memory. A declared length over
    /// the cap is refused before reading.
    static func boundedLoad(_ session: URLSession, _ request: URLRequest, maxBytes: Int) async throws -> (Data, URLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        // An error page's body is never used: don't download it.
        if let status = (response as? HTTPURLResponse)?.statusCode, !(200..<300).contains(status) {
            bytes.task.cancel()
            return (Data(), response)
        }
        if response.expectedContentLength > Int64(maxBytes) {
            bytes.task.cancel()
            throw MomentsAPIError.unexpectedResponse
        }
        var data = Data()
        data.reserveCapacity(Int(max(0, min(response.expectedContentLength, Int64(maxBytes)))))
        for try await byte in bytes {
            guard data.count < maxBytes else {
                bytes.task.cancel()
                throw MomentsAPIError.unexpectedResponse
            }
            data.append(byte)
        }
        return (data, response)
    }
}
