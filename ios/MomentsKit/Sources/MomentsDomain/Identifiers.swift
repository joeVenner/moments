import Foundation

/// An event slug as the server creates it (`src/worker/slugify.ts` plus a
/// random suffix): ASCII letters, digits and dashes, starting with a letter
/// or digit. Older slugs can contain "--" or end in "-", so both are allowed.
public struct EventSlug: Sendable, Hashable, Codable, CustomStringConvertible {
    public let value: String

    /// Validates the raw text as ASCII first (so look-alikes such as the
    /// Kelvin sign can't lowercase their way in), then lowercases it.
    public init?(_ raw: String) {
        guard (1...80).contains(raw.count),
              raw.wholeMatch(of: /[A-Za-z0-9][A-Za-z0-9-]*/) != nil
        else { return nil }
        value = raw.lowercased()
    }

    public var description: String { value }
}

/// The invite secret from an event link. Its descriptions are redacted so it
/// can't end up in logs, crash reports or `dump` output by accident; read
/// `value` only to send it to the access endpoint.
public struct InviteToken: Sendable, Hashable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let value: String

    /// Server tokens are 64 hex characters; anything outside a generous
    /// URL-safe shape is dropped rather than sent.
    public init?(_ raw: String) {
        guard (16...200).contains(raw.count), raw.wholeMatch(of: /[A-Za-z0-9_-]+/) != nil else { return nil }
        value = raw
    }

    public var description: String { "InviteToken(redacted)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

