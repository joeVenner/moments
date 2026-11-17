import Foundation
import MomentsDomain

/// Turns universal links, App Clip invocations and scanned QR codes into a
/// `Route`. Only https links on our own hosts are accepted; everything else
/// (other sites, other paths, malformed slugs) is nil, so a hostile QR code
/// can't steer the app anywhere.
public struct AppRouter: Sendable {
    public static let productionHosts: Set<String> = ["moments-hq.com", "www.moments-hq.com"]

    private let hosts: Set<String>
    private let allowsInsecureLocalhost: Bool

    /// - Parameter allowsInsecureLocalhost: accept `http://localhost:<port>`
    ///   too (development builds pointing at `npm run dev`).
    public init(hosts: Set<String> = AppRouter.productionHosts, allowsInsecureLocalhost: Bool = false) {
        self.hosts = Set(hosts.map { $0.lowercased() })
        self.allowsInsecureLocalhost = allowsInsecureLocalhost
    }

    public func route(for url: URL) -> Route? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil, components.password == nil,
              let host = components.host?.lowercased(),
              isAllowed(scheme: components.scheme?.lowercased(), host: host, port: components.port)
        else { return nil }

        // Work on the raw path: our paths never need percent-encoding, so any
        // "%" (an encoded "/", "." or non-ASCII) is refused outright.
        let rawPath = components.percentEncodedPath
        guard !rawPath.contains("%") else { return nil }
        // A trailing slash is harmless; empty segments elsewhere are not ours.
        var segments = rawPath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard segments.first == "" else { return nil }
        segments.removeFirst()
        if segments.last == "" { segments.removeLast() }
        guard segments.count >= 2, segments[0] == "e", let slug = EventSlug(segments[1]) else { return nil }

        switch segments.dropFirst(2).first {
        case nil:
            // Two invites is ambiguous (the web reads the first, other parsers
            // the last), so such a link is refused rather than guessed at.
            let invites = components.queryItems?.filter { $0.name == "invite" } ?? []
            guard invites.count <= 1 else { return nil }
            return .event(slug, invite: invites.first?.value.flatMap(InviteToken.init))
        case "slideshow" where segments.count == 3:
            return .slideshow(slug)
        default:
            return nil
        }
    }

    /// QR codes carry the same link as text; surrounding whitespace is ignored.
    public func route(forScannedText text: String) -> Route? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count <= 2048, let url = URL(string: trimmed) else { return nil }
        return route(for: url)
    }

    private func isAllowed(scheme: String?, host: String, port: Int?) -> Bool {
        switch scheme {
        case "https": hosts.contains(host) && (port == nil || port == 443)
        case "http": allowsInsecureLocalhost && (host == "localhost" || host == "127.0.0.1")
        default: false
        }
    }
}
