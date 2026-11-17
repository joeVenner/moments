import AppRouting
import Foundation
import CredentialStore
import MomentsDomain
import Observation

/// Turns incoming links into what the UI shows. The invite secret is kept
/// apart from UI state and handed out once, to the join flow.
@MainActor @Observable
final class AppNavigation {
    /// What is on screen; never carries a secret.
    enum Destination: Hashable {
        case event(EventSlug)
        case slideshow(EventSlug)
    }

    private(set) var destination: Destination?
    /// Bumped on every accepted link, so re-opening the same link still
    /// registers as a new open.
    private(set) var openCount = 0
    @ObservationIgnored private var pendingInvite: (slug: EventSlug, token: InviteToken)?
    @ObservationIgnored private let router: AppRouter

    init(router: AppRouter) {
        self.router = router
    }

    /// Unrecognised links are ignored (the current screen stays).
    @discardableResult
    func handle(_ url: URL) -> Bool {
        guard let route = router.route(for: url) else { return false }
        switch route {
        case let .event(slug, invite):
            pendingInvite = invite.map { (slug, $0) }
            destination = .event(slug)
        case let .slideshow(slug):
            pendingInvite = nil
            destination = .slideshow(slug)
        }
        openCount += 1
        return true
    }

    /// The invite that came with the link to `slug`, at most once.
    func takeInvite(for slug: EventSlug) -> InviteToken? {
        guard let pending = pendingInvite, pending.slug == slug else { return nil }
        pendingInvite = nil
        return pending.token
    }
}
