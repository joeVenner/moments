import CredentialStore
import Foundation
import MomentsAPI
import Observation
import OSLog

/// Whether the host is signed in on this device, and the sign-in and
/// sign-out actions. The token lives in the keychain (`HostSessionStore`);
/// screens never see it.
///
/// Reads (`currentToken`) never change state. Expiry and a keychain that was
/// locked at launch are picked up by `refresh()`, which screens call when they
/// appear and when the app comes to the foreground; a 401 from the server
/// (`sessionEnded(token:)`) is authoritative either way.
@MainActor @Observable
public final class HostAccount {
    public enum State: Equatable, Sendable {
        case signedOut
        case signedIn(expiresAt: Date)
    }

    /// Why a sign-in failed, for the message under the form.
    public enum SignInFailure: Equatable, Sendable {
        case invalidCredentials
        /// Too many failed logins: refused for 15 minutes, right or wrong.
        case locked
        /// The server has no admin login configured.
        case unavailable
        case appTooOld
        case offline
        case failed
    }

    public enum SignInOutcome: Equatable, Sendable {
        case signedIn
        case failed(SignInFailure)
        /// Another sign-in is running, the task was cancelled, or the host
        /// signed out meanwhile: show nothing.
        case ignored
    }

    public private(set) var state: State = .signedOut
    public private(set) var isSigningIn = false

    @ObservationIgnored private let service: any HostService
    @ObservationIgnored private let store: any HostSessionStore
    @ObservationIgnored private let now: @Sendable () -> Date
    /// Kept in memory too, so a keychain write failure still works this launch.
    @ObservationIgnored private var session: StoredHostSession?
    /// Bumped by every sign-out, so a sign-in that finishes later is dropped.
    @ObservationIgnored private var generation = 0
    /// A keychain removal failed; retried by `refresh()` and the next sign-in.
    @ObservationIgnored private var hasPendingRemoval = false
    @ObservationIgnored private let logger = Logger(subsystem: "moments", category: "host-account")

    public init(service: any HostService, store: any HostSessionStore, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.store = store
        self.now = now
        refresh()
    }

    /// The live token for host calls, or nil. Never changes state.
    public func currentToken() -> String? {
        guard let session, session.isLive(at: now()) else { return nil }
        return session.token
    }

    /// Drops an expired session, finishes a failed removal, and reads the
    /// keychain when signed out (it may have been locked at launch).
    public func refresh() {
        if hasPendingRemoval { removeStored() }
        if let session {
            if !session.isLive(at: now()) { forget() }
            return
        }
        let stored: StoredHostSession?
        do {
            stored = try store.load()
        } catch {
            logger.error("host session unreadable: \(String(describing: type(of: error)), privacy: .public)")
            return
        }
        guard let stored else { return }
        guard stored.isLive(at: now()) else { return forget() }
        session = stored
        state = .signedIn(expiresAt: stored.expiresAt)
    }

    public func signIn(username: String, password: String) async -> SignInOutcome {
        guard !isSigningIn else { return .ignored }
        let username = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !username.isEmpty, !password.isEmpty else { return .failed(.invalidCredentials) }
        isSigningIn = true
        defer { isSigningIn = false }
        let startedGeneration = generation
        let new: HostSession
        do {
            new = try await service.signIn(username: username, password: password)
        } catch is CancellationError {
            return .ignored
        } catch {
            return .failed(Self.failure(for: error))
        }
        guard generation == startedGeneration else {
            // Signed out while this was in flight: don't keep the new session.
            await revoke(new.token)
            return .ignored
        }
        let replaced = session?.token
        let stored = StoredHostSession(token: new.token, expiresAt: new.expiresAt)
        do {
            try store.save(stored)
            hasPendingRemoval = false
        } catch {
            // Signed in for this launch only. Remove any older item so a
            // later launch can't restore a session this one replaced.
            logger.error("host session not saved: \(String(describing: type(of: error)), privacy: .public)")
            removeStored()
        }
        session = stored
        state = .signedIn(expiresAt: new.expiresAt)
        if let replaced, replaced != new.token {
            // Off the sign-in path: a slow network mustn't hold up the form.
            Task { await self.revoke(replaced) }
        }
        return .signedIn
    }

    /// Signs out here at once; the server is told best-effort (the token
    /// expires on its own if that fails).
    public func signOut() async {
        let token = session?.token
        generation += 1
        forget()
        guard let token else { return }
        await revoke(token)
    }

    /// A host call with `token` answered `.hostAuthRequired`. Ignored when the
    /// host has meanwhile signed in again with a different token.
    public func sessionEnded(token: String) {
        guard session?.token == token else { return }
        forget()
    }

    private func revoke(_ token: String) async {
        do {
            try await service.signOut(token: token)
        } catch {
            logger.notice("server sign-out failed: \(String(describing: type(of: error)), privacy: .public)")
        }
    }

    private func forget() {
        session = nil
        state = .signedOut
        removeStored()
    }

    private func removeStored() {
        do {
            try store.remove()
            hasPendingRemoval = false
        } catch {
            hasPendingRemoval = true
            logger.error("host session not removed: \(String(describing: type(of: error)), privacy: .public)")
        }
    }

    static func failure(for error: any Error) -> SignInFailure {
        switch error as? MomentsAPIError {
        case .invalidCredentials, .invalidRequest: .invalidCredentials
        case .tooManyAttempts, .rateLimited: .locked
        case .signInUnavailable: .unavailable
        case .upgradeRequired: .appTooOld
        case .transport: .offline
        default: .failed
        }
    }
}
