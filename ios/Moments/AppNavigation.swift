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
    @ObservationIgnored private let now: () -> ContinuousClock.Instant
    /// A per-process hash of the last link, not the link: it carries the invite.
    @ObservationIgnored private var lastLink: (hash: Int, at: ContinuousClock.Instant)?

    /// The same link can arrive through both `onOpenURL` and the web user
    /// activity; deliveries this close together count once.
    static let duplicateWindow: Duration = .seconds(2)

    init(router: AppRouter, now: @escaping () -> ContinuousClock.Instant = { .now }) {
        self.router = router
        self.now = now
    }

    /// Unrecognised links are ignored (the current screen stays).
    @discardableResult
    func handle(_ url: URL) -> Bool {
        guard let route = router.route(for: url) else { return false }
        let arrivedAt = now()
        let hash = url.absoluteString.hashValue
        if let lastLink, lastLink.hash == hash, arrivedAt - lastLink.at < Self.duplicateWindow { return true }
        lastLink = (hash, arrivedAt)
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

    /// A link typed or pasted on the home screen; same rules as `handle(_:)`.
    @discardableResult
    func handle(text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count <= 2048, let url = URL(string: trimmed) else { return false }
        return handle(url)
    }

    /// An event picked on the home screen (already joined: no invite).
    func open(_ slug: EventSlug) {
        pendingInvite = nil
        lastLink = nil
        destination = .event(slug)
        openCount += 1
    }

    /// Back to the home screen from an event.
    func goHome() {
        pendingInvite = nil
        lastLink = nil
        destination = nil
        openCount += 1
    }

    /// The invite that came with the link to `slug`, at most once.
    func takeInvite(for slug: EventSlug) -> InviteToken? {
        guard let pending = pendingInvite, pending.slug == slug else { return nil }
        pendingInvite = nil
        return pending.token
    }
}
