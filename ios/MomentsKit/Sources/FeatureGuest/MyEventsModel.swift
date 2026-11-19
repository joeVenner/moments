import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Observation
import OSLog

/// The events this phone has joined, for the home screen. Built from the
/// credential store (a guest token means "joined"), with each event's details
/// fetched fresh; nothing about the list is kept anywhere else.
@MainActor @Observable
public final class MyEventsModel {
    public struct Entry: Identifiable, Hashable, Sendable {
        public enum Details: Hashable, Sendable {
            case loaded(Event)
            /// A private event whose grant expired: opening it asks for the PIN again.
            case locked
            /// Couldn't be fetched now (offline, server trouble): still openable.
            case unavailable
        }

        public let slug: EventSlug
        public let nickname: String?
        public let details: Details
        public var id: String { slug.value }

        public init(slug: EventSlug, nickname: String?, details: Details) {
            self.slug = slug
            self.nickname = nickname
            self.details = details
        }

        /// Newest first by start (or creation); entries without details last.
        var sortDate: Date? {
            guard case let .loaded(event) = details else { return nil }
            return event.startsAt ?? event.createdAt
        }
    }

    public enum Phase: Equatable {
        case idle, loading, loaded
        /// The keychain couldn't be read (e.g. locked); try again later.
        case unavailable
    }

    public private(set) var phase: Phase = .idle
    public private(set) var entries: [Entry] = []

    @ObservationIgnored private let service: any MomentsService
    @ObservationIgnored private let store: any EventCredentialStore
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let logger = Logger(subsystem: "moments", category: "my-events")

    public init(service: any MomentsService, store: any EventCredentialStore, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.store = store
        self.now = now
    }

    /// Reloads the whole list. Events that no longer exist are left out; their
    /// stored credentials stay until the slug is seen with another event.
    public func load() async {
        // `.task` and pull to refresh can overlap; one load at a time.
        guard phase != .loading else { return }
        phase = .loading
        let joined: [(EventSlug, StoredEventCredentials)]
        do {
            joined = try store.storedSlugs().compactMap { slug in
                // One unreadable item hides only itself.
                guard let stored = try? store.credentials(for: slug), stored.guestToken != nil else { return nil }
                return (slug, stored)
            }
        } catch {
            // Status only; never the store contents.
            logger.error("my events: credential store unavailable: \(String(describing: type(of: error)), privacy: .public)")
            phase = .unavailable
            return
        }
        var loaded: [Entry] = []
        for (slug, stored) in joined {
            if let entry = await fetch(slug, stored) { loaded.append(entry) }
            if Task.isCancelled { break }
        }
        // Home went away mid-load (or a refresh replaced it): a cancelled
        // fetch reads as "unavailable", so publish nothing from this run.
        guard !Task.isCancelled else {
            phase = entries.isEmpty ? .idle : .loaded
            return
        }
        entries = loaded.sorted(by: Self.order)
        phase = .loaded
    }

    private func fetch(_ slug: EventSlug, _ stored: StoredEventCredentials) async -> Entry? {
        let credentials = EventCredentials(accessGrant: stored.validAccessGrant(at: now()), guestToken: stored.guestToken)
        do {
            let event = try await service.event(slug: slug.value, credentials: credentials)
            // A reused slug: what was stored belongs to a deleted event, and
            // this lookup clears it (as the join flow's does).
            guard let current = try? store.credentials(for: slug, eventID: event.id), current.guestToken != nil else {
                return nil
            }
            return Entry(slug: slug, nickname: current.nickname, details: .loaded(event))
        } catch MomentsAPIError.eventNotFound {
            return nil
        } catch MomentsAPIError.accessRequired {
            return Entry(slug: slug, nickname: stored.nickname, details: .locked)
        } catch {
            return Entry(slug: slug, nickname: stored.nickname, details: .unavailable)
        }
    }

    private static func order(_ lhs: Entry, _ rhs: Entry) -> Bool {
        switch (lhs.sortDate, rhs.sortDate) {
        case let (l?, r?) where l != r: l > r
        case (.some, nil): true
        case (nil, .some): false
        default: lhs.slug.value < rhs.slug.value
        }
    }
}
