import Foundation
import MomentsAPI
import OSLog

/// Why a host screen couldn't load.
public enum HostLoadFailure: Equatable, Sendable {
    case offline
    case appTooOld
    case failed

    static func from(_ error: any Error) -> HostLoadFailure {
        switch error as? MomentsAPIError {
        case .transport: .offline
        case .upgradeRequired: .appTooOld
        default: .failed
        }
    }
}

/// How one authenticated host call ended.
enum HostCallOutcome<Value: Sendable>: Sendable {
    case success(Value)
    /// The call answered the `notFound` error the caller named.
    case notFound
    /// No session (any more): the screen should clear itself.
    case signedOut
    case cancelled
    case failure(HostLoadFailure)
}

extension HostAccount {
    /// Runs `call` with the current session token. An answer that arrives
    /// after the session changed (sign-out, or in again) is dropped and the
    /// call made once more with the new token; a dead token ends the session.
    ///
    /// When two passes still end on a changed session, the outcome is
    /// `.signedOut` and the screen clears; the next load starts fresh.
    func run<Value: Sendable>(
        logCategory: String,
        notFound: MomentsAPIError? = nil,
        _ call: (String) async throws -> Value
    ) async -> HostCallOutcome<Value> {
        for _ in 0..<2 {
            guard let token = currentToken() else { return .signedOut }
            do {
                let value = try await call(token)
                guard currentToken() == token else { continue }
                return .success(value)
            } catch is CancellationError {
                return .cancelled
            } catch let error as MomentsAPIError where notFound != nil && error == notFound {
                guard currentToken() == token else { continue }
                return .notFound
            } catch MomentsAPIError.hostAuthRequired {
                sessionEnded(token: token)
                if currentToken() == nil { return .signedOut }
            } catch {
                guard currentToken() == token else { continue }
                Logger(subsystem: "moments", category: logCategory)
                    .notice("host call failed: \(String(describing: type(of: error)), privacy: .public)")
                return .failure(HostLoadFailure.from(error))
            }
        }
        return .signedOut
    }
}
