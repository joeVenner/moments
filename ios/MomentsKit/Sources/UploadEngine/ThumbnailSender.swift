import Foundation

/// PUTs a feed thumbnail to its presigned URL.
public protocol ThumbnailSender: Sendable {
    /// Sends `data` with `Content-Type: image/jpeg`; throws unless storage
    /// accepted it. The URL is a bearer credential: never log it.
    func send(_ data: Data, to url: URL) async throws
}

/// A plain foreground upload: a thumbnail is small (≤ 200 KiB), and one
/// lost while the app is suspended just leaves the moment without one.
/// Same rules as the part uploaders: only https to an allowed storage host,
/// no redirects, no cookies or cache, so a compromised API can't send the
/// guest's picture anywhere else.
public final class URLSessionThumbnailSender: ThumbnailSender {
    public enum Problem: Error, Equatable {
        /// The URL isn't https to an allowed storage host.
        case untrustedTarget
        /// Storage answered with this status.
        case refused(status: Int)
    }

    private let hosts: StorageHostPolicy
    private let session: URLSession

    public init(hosts: StorageHostPolicy, configuration: URLSessionConfiguration = .ephemeral) {
        self.hosts = hosts
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        session = URLSession(configuration: configuration, delegate: RedirectRefuser(), delegateQueue: nil)
    }

    deinit { session.finishTasksAndInvalidate() }

    public func send(_ data: Data, to url: URL) async throws {
        guard let host = StorageTarget.storageHost(of: url), hosts.allows(host) else { throw Problem.untrustedTarget }
        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = "PUT"
        // Both are signed into the URL: anything else is refused by storage.
        // URLSession sets Content-Length from the body.
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        let (_, response) = try await session.upload(for: request, from: data)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else { throw Problem.refused(status: status) }
    }
}
