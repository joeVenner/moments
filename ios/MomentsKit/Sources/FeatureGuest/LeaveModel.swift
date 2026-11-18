import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Observation
import OSLog

/// "Leave this event and delete what I shared from the app". The server
/// works in steps, so this calls until it reports done; the stored identity
/// for the event is forgotten only then (it's what authenticates the steps).
@MainActor @Observable
public final class LeaveModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case leaving
        case left
        case failed(Failure)
    }

    public enum Failure: Equatable, Sendable {
        /// Too many requests; try again shortly.
        case busy
        /// This app build is too old; update to leave.
        case upgradeRequired
        /// Network, server or storage trouble (or this device's saved data
        /// couldn't be read); trying again continues. Nothing was lost.
        case temporary
        /// Left on the server, but this device's saved data couldn't be
        /// removed; trying again finishes.
        case storage
    }

    /// A guest with thousands of uploads takes many steps; past this the
    /// screen reports a temporary failure and a retry continues.
    nonisolated static let maxSteps = 60

    public private(set) var phase: Phase = .idle

    @ObservationIgnored private let slug: EventSlug
    @ObservationIgnored private let service: any LeaveService
    @ObservationIgnored private let store: any EventCredentialStore
    @ObservationIgnored private let logger = Logger(subsystem: "moments", category: "leave")

    public init(slug: EventSlug, service: any LeaveService, store: any EventCredentialStore) {
        self.slug = slug
        self.service = service
        self.store = store
    }

    /// Back to idle after the guest chose not to retry a failure.
    public func dismissFailure() {
        if case .failed = phase { phase = .idle }
    }

    public func leave() async {
        guard phase != .leaving, phase != .left else { return }
        phase = .leaving
        do {
            let stored = try store.credentials(for: slug)
            let credentials = EventCredentials(accessGrant: stored?.validAccessGrant(), guestToken: stored?.guestToken)
            // Never joined from this device: nothing to delete on the server.
            if credentials.guestToken != nil, try await !leaveOnServer(credentials) {
                return phase = .failed(.temporary)
            }
        } catch is CancellationError {
            return phase = .idle
        } catch MomentsAPIError.rateLimited {
            return phase = .failed(.busy)
        } catch MomentsAPIError.upgradeRequired {
            return phase = .failed(.upgradeRequired)
        } catch is MomentsAPIError {
            return phase = .failed(.temporary)
        } catch {
            // Before anything was deleted: the keychain couldn't be read.
            logger.error("reading the guest identity failed: \(String(describing: error), privacy: .public)")
            return phase = .failed(.temporary)
        }
        do {
            try store.removeCredentials(for: slug)
        } catch {
            logger.error("forgetting the guest identity failed: \(String(describing: error), privacy: .public)")
            return phase = .failed(.storage)
        }
        phase = .left
    }

    /// True once the server is done; false when it still had work after
    /// `maxSteps` calls.
    private func leaveOnServer(_ credentials: EventCredentials) async throws -> Bool {
        for _ in 0 ..< Self.maxSteps {
            try Task.checkCancellation()
            do {
                if try await service.leaveEvent(slug: slug.value, credentials: credentials) { return true }
            } catch MomentsAPIError.guestRequired {
                // The token is gone: a previous step finished (its answer
                // was lost) or the guest was removed. Either way, left.
                return true
            } catch MomentsAPIError.eventNotFound {
                // The event was purged: nothing of the guest is left there.
                return true
            }
        }
        return false
    }
}
