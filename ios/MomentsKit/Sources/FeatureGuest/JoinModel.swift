import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Observation
import OSLog

/// Drives joining one event: load it, unlock it when private (invite link or
/// PIN), then claim a nickname. Credentials go to the store only once the
/// event's ID is known, so they can't be filed under a reused slug.
@MainActor @Observable
public final class JoinModel: Identifiable {
    public enum Phase: Equatable, Sendable {
        case loading
        /// Private event: ask for the PIN.
        case needsAccess(AccessProblem?)
        case needsNickname(Event, NicknameProblem?)
        case joined(Event, Participant)
        case failed(Failure)
    }

    public enum AccessProblem: Equatable, Sendable {
        case wrongPIN
        /// The link's invite was refused (replaced by the host).
        case inviteRejected
        case tooManyAttempts(retryAfterSeconds: Int)
        /// A previous unlock expired or was revoked (new PIN).
        case expired
    }

    public enum NicknameProblem: Equatable, Sendable {
        case taken
        case invalid
        /// Too many joins from this network (a busy venue Wi-Fi); try again
        /// in a minute.
        case busy
    }

    public enum Failure: Equatable, Sendable {
        case eventNotFound
        case upgradeRequired
        /// Private events can't be unlocked right now (server not configured).
        case accessUnavailable
        /// Network or server trouble; `retry()` tries again.
        case temporary
        /// This device's saved data couldn't be read or written (keychain
        /// unavailable); `retry()` tries again.
        case storage
    }

    /// The server's limit, counted like the server (UTF-16 code units).
    public nonisolated static let maxNicknameLength = 60

    public let id = UUID()
    public let slug: EventSlug
    public private(set) var phase: Phase = .loading
    /// A request is in flight; intents are ignored until it ends.
    public private(set) var isWorking = false
    /// Joined, but the guest token couldn't be saved on this device yet;
    /// `retrySaving()` tries again. Losing it would lose the nickname.
    public private(set) var hasUnsavedIdentity = false
    /// Bumped after every step, so the view can re-announce a problem that
    /// repeats (a second wrong PIN leaves `phase` unchanged).
    public private(set) var stepCount = 0

    @ObservationIgnored private let service: any MomentsService
    @ObservationIgnored private let store: any EventCredentialStore
    @ObservationIgnored private var pendingInvite: InviteToken?
    /// A grant obtained this session, stored once the event ID is known.
    @ObservationIgnored private var freshGrant: AccessGrant?
    /// A join the store hasn't accepted yet.
    @ObservationIgnored private var unsavedJoin: (event: Event, result: JoinResult)?
    @ObservationIgnored private let logger = Logger(subsystem: "moments", category: "join")

    public init(slug: EventSlug, invite: InviteToken?, service: any MomentsService, store: any EventCredentialStore) {
        self.slug = slug
        self.pendingInvite = invite
        self.service = service
        self.store = store
    }

    // MARK: - Intents

    /// Loads the event, using the link's invite first when there is one.
    /// Safe to call repeatedly: ignored while a step runs or once past loading.
    public func start() async {
        guard !isWorking, phase == .loading || phase == .failed(.temporary) || phase == .failed(.storage) else { return }
        await perform { [self] in
            phase = .loading
            if let invite = pendingInvite {
                let outcome = try await unlock(.invite(invite.value))
                // Kept on network errors (thrown above) so a retry can use it.
                pendingInvite = nil
                if case let .refused(problem) = outcome { return phase = .needsAccess(problem) }
            }
            try await loadEvent()
        }
    }

    /// After a temporary failure.
    public func retry() async {
        await start()
    }

    public func submitPIN(_ pin: String) async {
        let trimmed = pin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isWorking, case .needsAccess = phase else { return }
        await perform { [self] in
            switch try await unlock(.pin(trimmed)) {
            case .unlocked: try await loadEvent()
            case let .refused(problem): phase = .needsAccess(problem)
            }
        }
    }

    public func join(nickname: String, avatarSeed: String = JoinModel.randomAvatarSeed()) async {
        guard case let .needsNickname(event, _) = phase, !isWorking else { return }
        let trimmed = nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.isValidNickname(trimmed) else { return phase = .needsNickname(event, .invalid) }
        await perform { [self] in
            let stored = try storedCredentials(for: event)
            switch try await claim(trimmed, avatarSeed: avatarSeed, event: event, stored: stored) {
            case let .accepted(result): saveAndShowJoined(event, result)
            case .rejected: phase = .needsNickname(event, .taken)
            case .invalid: phase = .needsNickname(event, .invalid)
            case .busy: phase = .needsNickname(event, .busy)
            }
        }
    }

    /// Saves a join the keychain refused earlier.
    public func retrySaving() {
        guard let unsavedJoin else { return }
        saveAndShowJoined(unsavedJoin.event, unsavedJoin.result)
    }

    public nonisolated static func isValidNickname(_ trimmed: String) -> Bool {
        !trimmed.isEmpty && trimmed.utf16.count <= maxNicknameLength
    }

    /// Eight base-36 characters, like the web's avatar seeds.
    public nonisolated static func randomAvatarSeed() -> String {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        return String((0..<8).map { _ in alphabet.randomElement()! })
    }

    // MARK: - Steps

    private enum UnlockOutcome { case unlocked, refused(AccessProblem) }
    private enum ClaimOutcome { case accepted(JoinResult), rejected, invalid, busy }

    private func unlock(_ credential: AccessCredential) async throws -> UnlockOutcome {
        do {
            freshGrant = try await service.access(slug: slug.value, credential: credential)
            return .unlocked
        } catch MomentsAPIError.invalidAccess {
            if case .invite = credential { return .refused(.inviteRejected) }
            return .refused(.wrongPIN)
        } catch let MomentsAPIError.tooManyAttempts(seconds) {
            return .refused(.tooManyAttempts(retryAfterSeconds: seconds))
        }
    }

    private func loadEvent() async throws {
        let stored = try store.credentials(for: slug)
        let event = try await service.event(slug: slug.value, credentials: requestCredentials(stored))
        let bound = try storedCredentials(for: event)
        // Returning guest: confirm the stored identity with the server (the
        // token may have been revoked) by re-joining under the same name.
        guard let nickname = bound?.nickname, bound?.guestToken != nil else {
            return phase = .needsNickname(event, nil)
        }
        let outcome: ClaimOutcome
        do {
            outcome = try await claim(nickname, avatarSeed: nil, event: event, stored: bound)
        } catch MomentsAPIError.guestRequired {
            // The server no longer knows this guest: a new one picks a name.
            outcome = .rejected
        }
        switch outcome {
        case let .accepted(result): saveAndShowJoined(event, result)
        case .rejected, .invalid:
            try store.update(for: slug) { $0.guestToken = nil; $0.participantID = nil; $0.nickname = nil }
            phase = .needsNickname(event, nil)
        case .busy:
            // Not a verdict on the stored identity: keep it and retry later.
            throw MomentsAPIError.rateLimited
        }
    }

    /// Joins under `nickname`. The server hands a token only to the request
    /// that wins the name; a token-less answer counts only when it is the
    /// participant this device already owns (re-join with a valid token).
    /// Before enforcement the server lets losers in without a token: treated
    /// here as taken, so two devices never share one guest.
    private func claim(_ nickname: String, avatarSeed: String?, event: Event, stored: StoredEventCredentials?) async throws -> ClaimOutcome {
        let result: JoinResult
        do {
            result = try await service.join(slug: slug.value, nickname: nickname, avatarSeed: avatarSeed, credentials: requestCredentials(stored))
        } catch MomentsAPIError.nicknameTaken {
            return .rejected
        } catch MomentsAPIError.invalidRequest {
            return .invalid
        } catch MomentsAPIError.rateLimited {
            return .busy
        }
        // Before enforcement a revoked token also gets a token-less 200 for the
        // same participant, so this can't detect revocation until then.
        // (A join whose response was lost can't be recovered either: the
        // server issues the token once and a retry sees `nickname_taken`.)
        let ownsIt = stored?.guestToken != nil && stored?.participantID == result.participant.id
        return result.guestToken != nil || ownsIt ? .accepted(result) : .rejected
    }

    private func saveAndShowJoined(_ event: Event, _ result: JoinResult) {
        do {
            try store.update(for: slug) { value in
                value.eventID = event.id
                if let token = result.guestToken { value.guestToken = token }
                value.participantID = result.participant.id
                value.nickname = result.participant.nickname
            }
            unsavedJoin = nil
            hasUnsavedIdentity = false
        } catch {
            logger.error("saving the guest identity failed: \(String(describing: error), privacy: .public)")
            // Only a newly issued token is irreplaceable; a confirmed
            // returning guest already has theirs stored.
            guard result.guestToken != nil else { return phase = .joined(event, result.participant) }
            unsavedJoin = (event, result)
            hasUnsavedIdentity = true
        }
        phase = .joined(event, result.participant)
    }

    /// Binds the stored entry to `event` and files a grant obtained this session.
    private func storedCredentials(for event: Event) throws -> StoredEventCredentials? {
        _ = try store.credentials(for: slug, eventID: event.id)
        if let grant = freshGrant {
            try store.update(for: slug) { value in
                value.eventID = event.id
                value.accessGrant = grant.token
                value.accessGrantExpiresAt = grant.expiresAt
            }
            freshGrant = nil
        }
        return try store.credentials(for: slug)
    }

    private func requestCredentials(_ stored: StoredEventCredentials?) -> EventCredentials {
        EventCredentials(
            accessGrant: freshGrant?.token ?? stored?.validAccessGrant(),
            guestToken: stored?.guestToken
        )
    }

    /// A stored grant the server no longer accepts.
    private func clearStoredGrant() throws {
        freshGrant = nil
        try store.update(for: slug) { $0.accessGrant = nil; $0.accessGrantExpiresAt = nil }
    }

    /// Runs one step, mapping errors that end it into `phase`.
    private func perform(_ step: () async throws -> Void) async {
        isWorking = true
        defer {
            isWorking = false
            stepCount += 1
        }
        do {
            try await step()
        } catch is CancellationError {
            return
        } catch MomentsAPIError.accessRequired {
            // After an unlock or mid-join it means access lapsed; on the first
            // load it just means the event is private.
            let lapsed = phase != .loading
            do {
                try clearStoredGrant()
            } catch {
                // Not sent again (freshGrant is nil); the next unlock overwrites it.
                logger.error("clearing a rejected grant failed: \(String(describing: error), privacy: .public)")
            }
            phase = .needsAccess(lapsed ? .expired : nil)
        } catch MomentsAPIError.eventNotFound {
            phase = .failed(.eventNotFound)
        } catch MomentsAPIError.upgradeRequired {
            phase = .failed(.upgradeRequired)
        } catch MomentsAPIError.accessUnavailable {
            phase = .failed(.accessUnavailable)
        } catch is MomentsAPIError {
            phase = .failed(.temporary)
        } catch {
            // The client only throws MomentsAPIError; anything else is the store.
            logger.error("join step failed: \(String(describing: error), privacy: .public)")
            phase = .failed(.storage)
        }
    }
}
