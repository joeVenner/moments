import Foundation
import MomentsAPI
import MomentsDomain

/// Which hosts storage URLs may point at. The app passes its own storage
/// account's host; nothing else is accepted, so even a compromised API
/// can't send photo bytes to a host of its choosing. Never allow the shared
/// `r2.cloudflarestorage.com` parent: every R2 customer has a host under it.
public struct StorageHostPolicy: Sendable {
    /// Hosts allowed as is or as a parent domain, compared on a label
    /// boundary.
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

/// The rules every part uploader applies to storage URLs and answers, so
/// the foreground and background uploaders can't drift apart.
enum StorageTarget {
    /// The batch's URLs for exactly these parts, in order: each https to an
    /// allowed, named host, naming the part it is listed under, on the
    /// session's pinned host.
    static func checked(
        _ batch: PartURLBatch, parts: [Int], hosts: StorageHostPolicy, pins: Pins, sessionID: String
    ) throws -> [(part: Int, url: URL)] {
        try parts.map { number in
            guard let url = batch.urls[number], let host = storageHost(of: url), hosts.allows(host),
                  partNumber(in: url) == number, pins.pin(host, for: sessionID)
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

    /// Storage's answer as the queue understands it.
    static func check(_ response: URLResponse?) throws(MomentsAPIError) {
        guard let http = response as? HTTPURLResponse else { throw .unexpectedResponse }
        switch http.statusCode {
        case 200 ..< 300:
            // An ETag is storage's receipt for the part.
            guard let etag = http.value(forHTTPHeaderField: "ETag"), !etag.isEmpty else { throw .unexpectedResponse }
        // 400 too: S3-style stores use it for timeouts and expired requests.
        case 400, 403, 408, 429, 500...: throw .storageUnavailable
        // The multipart upload is gone: the queue re-reads the session.
        case 404: throw .uploadNotOpen
        // The part itself is unacceptable; sending it again won't help.
        case 411, 413: throw .invalidUpload
        // Includes refused redirects.
        default: throw .unexpectedResponse
        }
    }

    /// Whether a failed send is worth reporting the parts that went through
    /// before it (the rest are retried) rather than the error.
    static func isRetryable(_ error: any Error) -> Bool {
        (error as? MomentsAPIError)?.isRetryable ?? (error is CancellationError)
    }
}

/// The first storage host seen per session; later URLs must match it.
final class Pins: @unchecked Sendable {
    /// Pins are forgotten beyond this many sessions.
    static let maxSessions = 256
    private let lock = NSLock()
    private var hosts: [String: String] = [:]

    func pin(_ host: String, for sessionID: String) -> Bool {
        lock.withLock {
            if let pinned = hosts[sessionID] { return pinned == host }
            if hosts.count >= Self.maxSessions { hosts.removeAll() }
            hosts[sessionID] = host
            return true
        }
    }
}

/// Refuses every redirect: storage answers directly or not at all.
/// (Background sessions follow redirects without asking; the background
/// uploader checks the final URL instead.)
final class RedirectRefuser: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}
