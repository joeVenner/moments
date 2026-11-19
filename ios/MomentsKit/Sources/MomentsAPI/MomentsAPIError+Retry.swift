import Foundation

public extension MomentsAPIError {
    /// Whether trying the same request again later can succeed without the
    /// guest doing anything: network trouble, rate limits, server or storage
    /// outages. Everything else needs a different request or a person.
    var isRetryable: Bool {
        switch self {
        case .transport, .rateLimited, .tooManyUploads, .storageUnavailable, .unexpectedResponse:
            true
        case let .server(status, _):
            status >= 500 || status == 408
        case .accessRequired, .invalidAccess, .tooManyAttempts, .accessUnavailable, .eventNotFound,
             .upgradeRequired, .nicknameTaken, .momentNotFound, .guestRequired, .invalidRequest,
             .uploadsClosed, .uploadNotFound, .uploadNotOpen, .uploadConflict, .invalidUpload, .uploadsUnavailable,
             .invalidCredentials, .hostAuthRequired, .signInUnavailable:
            false
        }
    }
}
