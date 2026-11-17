import Foundation

/// Every failure `MomentsClient` throws (plus `CancellationError` when the
/// calling task is cancelled). The runtime's own errors are never passed on:
/// their descriptions print request headers, including access grants and
/// guest tokens, and would leak into logs or crash reports.
public enum MomentsAPIError: Error, Sendable, Equatable {
    /// Private event: get a grant from the access endpoint (PIN or invite).
    case accessRequired
    /// Wrong PIN or invite token.
    case invalidAccess
    /// Too many wrong PINs from this network: wait, or use the invite link.
    case tooManyAttempts(retryAfterSeconds: Int)
    /// The server can't grant private access right now (misconfiguration).
    case accessUnavailable
    /// No live event with this slug (unknown, expired or archived).
    case eventNotFound
    /// This build is below the server minimum: show the update screen.
    case upgradeRequired
    /// Another device owns this nickname in the event.
    case nicknameTaken
    /// The server rejected the request as malformed (a client bug).
    case invalidRequest
    /// The response did not have the documented shape.
    case unexpectedResponse
    /// Network failure (offline, timeout, TLS): safe to retry.
    case transport(URLError.Code?)
    /// Any other status, with the server's stable `code` when it sent one.
    case server(status: Int, code: String?)
}
