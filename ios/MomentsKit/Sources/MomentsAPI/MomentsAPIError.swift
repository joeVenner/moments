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
    /// The moment is gone or hidden by the host.
    case momentNotFound
    /// Only devices that joined the event may do this (guest tokens enforced).
    case guestRequired
    /// Too many requests from this device; slow down and try later.
    case rateLimited
    /// The event stopped taking uploads (and the finishing grace has passed).
    case uploadsClosed
    /// No such upload session for this guest in this event.
    case uploadNotFound
    /// The session was cancelled: queue the item again under a new id.
    case uploadNotOpen
    /// This client upload id was already used for a different file.
    case uploadConflict
    /// Too many unfinished uploads (for this guest or the event): finish some first.
    case tooManyUploads
    /// Unsupported type, size or caption.
    case invalidUpload
    /// The server has no direct-upload storage configured.
    case uploadsUnavailable
    /// Storage failed on the server side: retry later.
    case storageUnavailable
    /// The server rejected the request as malformed (a client bug).
    case invalidRequest
    /// The response did not have the documented shape.
    case unexpectedResponse
    /// Network failure (offline, timeout, TLS): safe to retry.
    case transport(URLError.Code?)
    /// Host sign-in: wrong username or password.
    case invalidCredentials
    /// Host screens: no live session (expired, signed out, or the admin
    /// password changed). Forget the token and sign in again.
    case hostAuthRequired
    /// Host sign-in isn't configured on the server.
    case signInUnavailable
    /// Any other status, with the server's stable `code` when it sent one.
    case server(status: Int, code: String?)
}
