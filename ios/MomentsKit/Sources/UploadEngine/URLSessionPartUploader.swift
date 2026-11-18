import Foundation
import MomentsAPI
import MomentsDomain

/// Sends parts straight to storage with presigned PUT URLs. Each part is
/// copied from the checked staged-file handle into a part file in the
/// item's staging folder, uploaded and deleted.
///
/// Storage is a different trust zone from the API: requests carry no API
/// headers (the URL is the credential), redirects are refused (a redirect
/// would carry the bytes elsewhere), and every URL must be https to a named
/// host — never an IP address or localhost — and, once a session's first
/// URL was seen, the same host as that one.
///
/// Parts go one at a time. This is the foreground uploader; a background
/// URLSession variant follows.
public final class URLSessionPartUploader: NSObject, PartUploader, URLSessionTaskDelegate, @unchecked Sendable {
    private let service: any UploadService
    private let staging: StagingArea
    private let allowsHost: @Sendable (String) -> Bool
    private let lock = NSLock()
    private let fileLock = NSLock()
    private var pinnedHosts: [String: String] = [:]
    private var session: URLSession!

    /// - Parameter allowsHost: extra check on storage hosts (for example a
    ///   known suffix); the built-in rules always apply.
    public init(
        service: any UploadService, staging: StagingArea, configuration: URLSessionConfiguration = .ephemeral,
        allowsHost: @escaping @Sendable (String) -> Bool = { _ in true }
    ) {
        self.service = service
        self.staging = staging
        self.allowsHost = allowsHost
        super.init()
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    deinit {
        session.invalidateAndCancel()
    }

    public func upload(
        parts: [Int], session ref: QueuedUpload.SessionRef, item: QueuedUpload, file: FileHandle,
        credentials: EventCredentials
    ) async throws -> Set<Int> {
        guard !parts.isEmpty else { return [] }
        let batch = try await service.partURLs(slug: item.eventSlug, uploadID: ref.id, parts: parts, credentials: credentials)
        let urls = try checked(batch, for: ref.id, parts: parts)
        var sent: Set<Int> = []
        for number in parts {
            do {
                try Task.checkCancellation()
                try await send(part: number, of: ref, item: item, file: file, to: urls[number]!)
                sent.insert(number)
            } catch {
                // Parts already sent are progress; report them and let the
                // queue retry the rest. Nothing sent: report the error.
                if sent.isEmpty { throw error }
                return sent
            }
        }
        return sent
    }

    // MARK: URLs

    /// The batch's URLs for exactly these parts, after the host rules.
    private func checked(_ batch: PartURLBatch, for sessionID: String, parts: [Int]) throws -> [Int: URL] {
        var urls: [Int: URL] = [:]
        for number in parts {
            guard let url = batch.urls[number], let host = Self.storageHost(of: url), allowsHost(host),
                  pin(host, for: sessionID)
            else { throw MomentsAPIError.unexpectedResponse }
            urls[number] = url
        }
        return urls
    }

    /// The URL's host if it is https to a named host (not an IP literal,
    /// not localhost), with no user info.
    static func storageHost(of url: URL) -> String? {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              let host = url.host(percentEncoded: false)?.lowercased(), !host.isEmpty
        else { return nil }
        let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if bare == "localhost" || bare.hasSuffix(".localhost") || bare.contains(":") { return nil }
        // Dotted digits only: an IPv4 literal.
        if bare.allSatisfy({ $0.isNumber || $0 == "." }) { return nil }
        if bare.hasSuffix(".") || bare.contains("..") { return nil }
        return bare
    }

    /// First host seen for a session wins; later URLs must match it.
    private func pin(_ host: String, for sessionID: String) -> Bool {
        lock.withLock {
            if let pinned = pinnedHosts[sessionID] { return pinned == host }
            pinnedHosts[sessionID] = host
            return true
        }
    }

    // MARK: Sending

    private func send(part number: Int, of ref: QueuedUpload.SessionRef, item: QueuedUpload, file: FileHandle, to url: URL) async throws {
        guard let range = UploadPlan.byteRange(part: number, size: item.file.size, partSize: ref.partSize) else {
            throw MomentsAPIError.invalidUpload
        }
        let partURL = staging.folder(for: item.id).appending(path: ".part-\(number)-\(UUID().uuidString)")
        do throws(PartFile.Problem) {
            try writePart(from: file, range: range, to: partURL)
        } catch .shortRead {
            throw MomentsAPIError.invalidUpload
        } catch {
            throw MomentsAPIError.transport(nil)
        }
        defer { unlink(partURL.path(percentEncoded: false)) }

        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let response: URLResponse
        do {
            (_, response) = try await session.upload(for: request, fromFile: partURL, delegate: TaskLabel(item: item.id, part: number))
        } catch let error as URLError {
            throw MomentsAPIError.transport(error.code)
        }
        try Self.check(response)
    }

    /// One reader at a time: the handle's offset is shared.
    private func writePart(from file: FileHandle, range: Range<Int64>, to url: URL) throws(PartFile.Problem) {
        fileLock.lock()
        defer { fileLock.unlock() }
        try PartFile.write(from: file, range: range, to: url)
    }

    /// Storage's answer as the queue understands it.
    static func check(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw MomentsAPIError.unexpectedResponse }
        switch http.statusCode {
        case 200 ..< 300:
            // An ETag is storage's receipt for the part.
            guard let etag = http.value(forHTTPHeaderField: "ETag"), !etag.isEmpty else {
                throw MomentsAPIError.unexpectedResponse
            }
        // Expired or refused signature: new URLs next time.
        case 403: throw MomentsAPIError.storageUnavailable
        // The multipart upload is gone: the queue re-reads the session.
        case 404: throw MomentsAPIError.uploadNotOpen
        case 400, 411, 413: throw MomentsAPIError.invalidUpload
        case 408, 429, 500...: throw MomentsAPIError.storageUnavailable
        // Includes refused redirects.
        default: throw MomentsAPIError.unexpectedResponse
        }
    }

    // MARK: URLSessionTaskDelegate

    public func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}

/// Labels a task by item and part only: never the URL (a credential) or
/// anything about the file.
private final class TaskLabel: NSObject, URLSessionTaskDelegate, Sendable {
    let label: String
    init(item: UUID, part: Int) { label = "\(item.uuidString):\(part)" }

    func urlSession(_ session: URLSession, didCreateTask task: URLSessionTask) {
        task.taskDescription = label
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}
