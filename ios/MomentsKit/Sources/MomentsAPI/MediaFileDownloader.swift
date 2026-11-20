import Foundation

/// Downloads whole media files to disk for "Download everything": a video
/// can be hundreds of megabytes, so nothing is held in memory. Only files on
/// the API origin are fetched, over the API's hardened session settings (no
/// redirects, cookies or cache). Host media URLs carry their own `mv`
/// signature, so no token or grant is sent, and URLs are never logged.
public struct MediaFileDownloader: Sendable {
    /// Fetches a request into a temporary file the caller then owns.
    public typealias Fetch = @Sendable (_ request: URLRequest) async throws -> (URL, URLResponse)

    private let origin: (scheme: String, host: String, port: Int?)
    private let identity: ClientIdentity
    private let fetch: Fetch
    private let directory: URL

    /// - Parameters:
    ///   - directory: where finished files go (default: the temporary directory).
    ///   - fetch: tests only; the default downloads with redirects refused.
    public init(baseURL: URL, identity: ClientIdentity, directory: URL? = nil, fetch: Fetch? = nil) throws {
        guard MomentsClient.isAllowedBaseURL(baseURL),
              let scheme = baseURL.scheme?.lowercased(), let host = baseURL.host()?.lowercased()
        else { throw MomentsClient.ConfigurationError.insecureBaseURL }
        origin = (scheme, host, baseURL.port)
        self.identity = identity
        self.directory = directory ?? FileManager.default.temporaryDirectory
        if let fetch {
            self.fetch = fetch
        } else {
            // A big video may take far longer than the API's 2 minutes.
            let session = MomentsClient.makeSession(requestTimeout: 60, resourceTimeout: 60 * 60)
            self.fetch = { request in try await session.download(for: request) }
        }
    }

    func isOwnOrigin(_ url: URL) -> Bool {
        url.scheme?.lowercased() == origin.scheme && url.host()?.lowercased() == origin.host
            && url.port == origin.port && url.user() == nil && url.password() == nil
    }

    /// Downloads `url` into a new file in `directory`, named uniquely with
    /// the URL's extension (Photos uses it to tell a photo from a video).
    /// The file is the caller's to delete; on any failure nothing is left.
    public func download(_ url: URL) async throws -> URL {
        guard isOwnOrigin(url) else { throw MomentsAPIError.invalidRequest }
        var request = URLRequest(url: url)
        request.setValue(identity.headerValue, forHTTPHeaderField: "X-Client")
        let temporary: URL
        let response: URLResponse
        do {
            (temporary, response) = try await fetch(request)
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
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard let http = response as? HTTPURLResponse else { throw MomentsAPIError.unexpectedResponse }
        switch http.statusCode {
        case 200..<300: break
        case 401, 403: throw MomentsAPIError.accessRequired
        case 404: throw MomentsAPIError.eventNotFound
        default: throw MomentsAPIError.server(status: http.statusCode, code: nil)
        }
        let fileExtension = Self.safeExtension(url.pathExtension)
        var destination = directory.appending(path: UUID().uuidString, directoryHint: .notDirectory)
        if let fileExtension { destination.appendPathExtension(fileExtension) }
        do {
            try FileManager.default.moveItem(at: temporary, to: destination)
        } catch {
            throw MomentsAPIError.transport(nil)
        }
        return destination
    }

    /// A short alphanumeric extension, or nil.
    static func safeExtension(_ value: String) -> String? {
        let lowered = value.lowercased()
        guard (1...5).contains(lowered.count), lowered.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else {
            return nil
        }
        return lowered
    }
}
