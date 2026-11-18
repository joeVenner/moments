import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain

/// The stored credentials for an event, as the API wants them.
func eventCredentials(store: any EventCredentialStore, slug: EventSlug) throws -> EventCredentials {
    let stored = try store.credentials(for: slug)
    return EventCredentials(accessGrant: stored?.validAccessGrant(), guestToken: stored?.guestToken)
}

/// Loading rules shared by highlights and the leaderboard: whole-event reads
/// that share a per-network rate limit, so no polling. They load when shown
/// (unless loaded moments ago) and on pull to refresh.
public enum EventReadPhase: Equatable, Sendable {
    case loading
    case loaded
    /// Nothing loaded yet and the last try failed; `refresh()` tries again.
    case failed
}

struct ReloadThrottle {
    /// A tab shown again within this keeps what it has.
    static let freshFor: TimeInterval = 30
    private(set) var lastLoaded: Date?

    func isStale(at now: Date) -> Bool {
        guard let lastLoaded else { return true }
        return now.timeIntervalSince(lastLoaded) >= Self.freshFor
    }

    mutating func markLoaded(at now: Date) {
        lastLoaded = now
    }
}
