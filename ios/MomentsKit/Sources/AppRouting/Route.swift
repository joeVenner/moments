import MomentsDomain

/// Where a link or QR code takes the guest.
public enum Route: Sendable, Hashable {
    /// `/e/{slug}`, optionally carrying the invite that unlocks a private event.
    case event(EventSlug, invite: InviteToken?)
    /// `/e/{slug}/slideshow`.
    case slideshow(EventSlug)

    public var slug: EventSlug {
        switch self {
        case let .event(slug, _), let .slideshow(slug): slug
        }
    }
}
