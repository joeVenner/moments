import Foundation
import MomentsAPI
import MomentsDomain

/// Which hosts storage URLs may point at. The app passes its own storage
/// account's host; nothing else is accepted, so even a compromised API
/// can't send photo bytes to a host of its choosing. Never allow the shared
/// `r2.cloudflarestorage.com` parent: every R2 customer has a host under it.
public struct StorageHostPolicy: Sendable {
    /// Hosts allowed as is or as a parent domain (`r2.cloudflarestorage.com`
    /// allows `acct.r2.cloudflarestorage.com`), compared on a label boundary.
    public let domains: [String]

    public init(domains: [String]) {
        self.domains = domains.map { $0.lowercased() }
    }

    /// Exactly one R2 account's S3 host, `<account id>.r2.cloudflarestorage.com`.
    /// Nil when the id isn't a 32-character hex account id.
    public static func r2Account(_ accountID: String) -> StorageHostPolicy? {
        let id = accountID.lowercased()
        guard id.count == 32, id.allSatisfy(\.isHexDigit) else { return nil }
        return StorageHostPolicy(domains: ["\(id).r2.cloudflarestorage.com"])
    }

    func allows(_ host: String) -> Bool {
        domains.contains { host == $0 || host.hasSuffix("." + $0) }
    }
}

/// Sends parts straight to storage with presigned PUT URLs. Each part is
/// copied from the checked staged-file handle into a part file in the
/// staging area's parts folder (wiped at launch), uploaded and deleted.
///
/// Storage is a different trust zone from the API: requests carry no API
/// headers (the URL is the credential), redirects are refused (a redirect
/// would carry the bytes elsewhere), and every URL must be https to an
/// allowed, named host, for the part it claims to be, on the same host as
/// the session's first URL.
///
/// Parts go one at a time. This is the foreground uploader; a background
/// URLSession variant follows. Call `invalidate()` when done with it.
public final class URLSessionPartUploader: PartUploader, Sendable {
    /// Hosts pinned per session are forgotten beyond this many sessions.
    static let maxPinnedSessions = 256

    private let service: any UploadService
    private let staging: StagingArea
    private let hosts: StorageHostPolicy
    private let session: URLSession
    private let pins = Pins()

    public init(
        service: any UploadService, staging: StagingArea, hosts: StorageHostPolicy,
        configuration: URLSessionConfiguration = .ephemeral
    ) {
        self.service = service
        self.staging = staging
        self.hosts = hosts
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        // The delegate holds nothing, so the session doesn't keep the
        // uploader alive.
        session = URLSession(configuration: configuration, delegate: RedirectRefuser(), delegateQueue: nil)
    }

    /// Cancels uploads in flight and releases the session.
    public func invalidate() {
        session.invalidateAndCancel()
    }

    public func upload(
        parts: [Int], session ref: QueuedUpload.SessionRef, item: QueuedUpload, file: FileHandle,
        credentials: EventCredentials
    ) async throws -> Set<Int> {
        let parts = Array(Set(parts)).sorted()
        guard !parts.isEmpty else { return [] }
        let batch = try await service.partURLs(slug: item.eventSlug, uploadID: ref.id, parts: parts, credentials: credentials)
        let targets = try checked(batch, for: ref.id, parts: parts)
        var sent: Set<Int> = []
        for (number, url) in targets {
            do {
                try Task.checkCancellation()
                try await send(part: number, of: ref, item: item, file: file, to: url)
                sent.insert(number)
            } catch {
                // Parts already sent are progress the queue should record;
                // the rest is retried. A refusal of the file itself, or
                // nothing sent at all, is reported as the error.
                if sent.isEmpty || !Self.isRetryable(error) { throw error }
                return sent
            }
        }
        return sent
    }

    private static func isRetryable(_ error: any Error) -> Bool {
        (error as? MomentsAPIError)?.isRetryable ?? (error is CancellationError)
    }

    // MARK: URLs

    /// The batch's URLs for exactly these parts, in order, after the host
    /// rules and a check that each URL is for the part it is listed under.
    private func checked(_ batch: PartURLBatch, for sessionID: String, parts: [Int]) throws -> [(Int, URL)] {
        try parts.map { number in
            guard let url = batch.urls[number], let host = Self.storageHost(of: url), hosts.allows(host),
                  Self.partNumber(in: url) == number, pins.pin(host, for: sessionID)
            else { throw MomentsAPIError.unexpectedResponse }
            return (number, url)
        }
    }

    /// The URL's host if it is https to a plain ASCII domain name: no IP
    /// literal in any notation (decimal, octal, hex, IPv6), no localhost,
    /// `.local` or `.internal`, no single label, no user info.
    static func storageHost(of url: URL) -> String? {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              let host = url.host(percentEncoded: false)?.lowercased(),
              !host.isEmpty, host.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == ".") })
        else { return nil }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2, labels.allSatisfy({ !$0.isEmpty && $0.count <= 63 }), let last = labels.last else { return nil }
        // A numeric or 0x last label makes the resolver read the host as an
        // IPv4 address (WHATWG URL rule); real top-level domains are letters.
        guard last.count >= 2, last.first!.isLetter, !last.hasPrefix("0x") else { return nil }
        if ["localhost", "local", "internal", "home", "lan"].contains(String(last)) { return nil }
        return host
    }

    /// The `partNumber` query item, as storage reads it.
    static func partNumber(in url: URL) -> Int? {
        let values = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
            .filter { $0.name == "partNumber" }.compactMap(\.value) ?? []
        guard values.count == 1 else { return nil }
        return Int(values[0])
    }

    // MARK: Sending

    private func send(part number: Int, of ref: QueuedUpload.SessionRef, item: QueuedUpload, file: FileHandle, to url: URL) async throws {
        guard let range = UploadPlan.byteRange(part: number, size: item.file.size, partSize: ref.partSize) else {
            throw MomentsAPIError.invalidUpload
        }
        let partURL: URL
        do throws(StagingArea.Problem) {
            partURL = try staging.partsFolder().appending(path: "\(item.id.uuidString)-\(number)-\(UUID().uuidString)")
        } catch {
            throw MomentsAPIError.transport(nil)
        }
        do throws(PartFile.Problem) {
            try PartFile.write(from: file, range: range, to: partURL)
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

    /// Storage's answer as the queue understands it.
    static func check(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw MomentsAPIError.unexpectedResponse }
        switch http.statusCode {
        case 200 ..< 300:
            // An ETag is storage's receipt for the part.
            guard let etag = http.value(forHTTPHeaderField: "ETag"), !etag.isEmpty else {
                throw MomentsAPIError.unexpectedResponse
            }
        // 400 too: S3-style stores use it for timeouts and expired requests.
        case 400, 403, 408, 429, 500...: throw MomentsAPIError.storageUnavailable
        // The multipart upload is gone: the queue re-reads the session.
        case 404: throw MomentsAPIError.uploadNotOpen
        // The part itself is unacceptable; sending it again won't help.
        case 411, 413: throw MomentsAPIError.invalidUpload
        // Includes refused redirects.
        default: throw MomentsAPIError.unexpectedResponse
        }
    }
}

/// The first storage host seen per session; later URLs must match it.
private final class Pins: @unchecked Sendable {
    private let lock = NSLock()
    private var hosts: [String: String] = [:]

    func pin(_ host: String, for sessionID: String) -> Bool {
        lock.withLock {
            if let pinned = hosts[sessionID] { return pinned == host }
            if hosts.count >= URLSessionPartUploader.maxPinnedSessions { hosts.removeAll() }
            hosts[sessionID] = host
            return true
        }
    }
}

/// Refuses every redirect: storage answers directly or not at all.
final class RedirectRefuser: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}

/// Labels a task by item and part only: never the URL (a credential) or
/// anything about the file. Refuses redirects too, as task delegates are
/// asked first.
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
