import Foundation

/// An event as the host's list shows it.
public struct AdminEvent: Sendable, Hashable, Identifiable {
    /// Where the event comes from, which decides its rules.
    public enum Kind: String, Sendable, Hashable, CaseIterable {
        /// From before hosting plans.
        case legacy
        /// The operator's own.
        case operatorOwned = "operator"
        /// Paid by the host's plan.
        case main
        /// The plan's one-month test event (fixed dates, few guests).
        case test
    }

    public let event: Event
    public let kind: Kind
    /// The guest limit the host is told (joins allow 10% more on a main
    /// event); nil for no limit, or a main event its plan no longer covers.
    public let guestCap: Int?
    /// Every moment, hidden ones included.
    public let momentCount: Int
    /// Guests currently in the event.
    public let participantCount: Int

    public var id: String { event.id }

    public init(event: Event, kind: Kind, guestCap: Int? = nil, momentCount: Int, participantCount: Int) {
        self.event = event
        self.kind = kind
        self.guestCap = guestCap
        self.momentCount = momentCount
        self.participantCount = participantCount
    }
}

/// The host's events, newest first.
public struct AdminEventList: Sendable, Hashable {
    public let events: [AdminEvent]
    /// Older events were left out by the server's cap (500).
    public let isTruncated: Bool

    public init(events: [AdminEvent], isTruncated: Bool) {
        self.events = events
        self.isTruncated = isTruncated
    }
}

/// What a host shares for one event. Printing it never shows the invite
/// link (it opens a private event without the PIN).
public struct EventShareLinks: Sendable, Hashable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    /// The guest page: what the QR code opens.
    public let eventURL: URL
    /// Private events only. It opens the event without its PIN, so the app
    /// shares it only on an explicit tap.
    public let inviteURL: URL?

    public init(eventURL: URL, inviteURL: URL?) {
        self.eventURL = eventURL
        self.inviteURL = inviteURL
    }

    public var description: String {
        "EventShareLinks(eventURL: \(eventURL), inviteURL: \(inviteURL == nil ? "nil" : "redacted"))"
    }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["eventURL": eventURL, "hasInvite": inviteURL != nil])
    }
}

/// An event's activity, as the web admin shows it.
public struct EventAnalytics: Sendable, Hashable {
    public struct DayCount: Sendable, Hashable {
        /// UTC `YYYY-MM-DD`.
        public let day: String
        public let count: Int

        public init(day: String, count: Int) {
            self.day = day
            self.count = count
        }
    }

    public let totalMoments: Int
    public let hiddenMoments: Int
    public let photos: Int
    public let videos: Int
    public let storageBytes: Int
    public let participants: Int
    public let reactions: Int
    /// Moments per day over the last two weeks, oldest first; empty days absent.
    public let activity: [DayCount]

    public init(
        totalMoments: Int, hiddenMoments: Int, photos: Int, videos: Int, storageBytes: Int,
        participants: Int, reactions: Int, activity: [DayCount]
    ) {
        self.totalMoments = totalMoments
        self.hiddenMoments = hiddenMoments
        self.photos = photos
        self.videos = videos
        self.storageBytes = storageBytes
        self.participants = participants
        self.reactions = reactions
        self.activity = activity
    }
}

/// One event for the host's detail screen.
public struct AdminEventDetail: Sendable, Hashable {
    public let summary: AdminEvent
    public let share: EventShareLinks
    public let analytics: EventAnalytics

    public init(summary: AdminEvent, share: EventShareLinks, analytics: EventAnalytics) {
        self.summary = summary
        self.share = share
        self.analytics = analytics
    }
}

/// One moment as the host sees it, hidden ones included.
public struct AdminMoment: Sendable, Hashable, Identifiable {
    public enum Status: String, Sendable, Hashable {
        /// Visible to guests.
        case approved
        /// Hidden from guests; only the host sees it.
        case hidden
    }

    public let id: String
    public let eventID: String
    public let uploaderName: String
    public let caption: String?
    public let createdAt: Date
    public let sizeBytes: Int?
    public var status: Status
    public let reactionCount: Int
    /// Its `/media/...` URLs carry a short-lived host view signature; reload
    /// the list for fresh ones.
    public let media: Media

    public init(
        id: String, eventID: String, uploaderName: String, caption: String? = nil, createdAt: Date,
        sizeBytes: Int? = nil, status: Status, reactionCount: Int = 0, media: Media
    ) {
        self.id = id
        self.eventID = eventID
        self.uploaderName = uploaderName
        self.caption = caption
        self.createdAt = createdAt
        self.sizeBytes = sizeBytes
        self.status = status
        self.reactionCount = reactionCount
        self.media = media
    }

    public var isHidden: Bool { status == .hidden }
}

/// An event's moments for moderation, newest first.
public struct AdminMomentList: Sendable, Hashable {
    public let moments: [AdminMoment]
    /// True when older moments were left out (the server sends at most 500).
    public let isTruncated: Bool

    public init(moments: [AdminMoment], isTruncated: Bool) {
        self.moments = moments
        self.isTruncated = isTruncated
    }
}

/// What a host writes about an event: the create and edit forms' fields.
/// Text is sent as given (trim it first); nil clears an optional field.
public struct EventDetails: Sendable, Hashable {
    public var title: String
    public var type: String
    public var mainCharacters: String?
    public var description: String?
    public var startsAt: Date?

    public init(title: String, type: String, mainCharacters: String? = nil, description: String? = nil, startsAt: Date? = nil) {
        self.title = title
        self.type = type
        self.mainCharacters = mainCharacters
        self.description = description
        self.startsAt = startsAt
    }
}

/// The signed-in host's hosting plan, as the server reports it.
public struct HostPlan: Sendable, Hashable {
    public enum State: String, Sendable, Hashable {
        /// Paid and renewing.
        case active
        /// Paid until `periodEndsAt`, won't renew.
        case canceling
        /// A payment failed; full service while Apple retries.
        case grace
        /// Grace is over: guests can only look, the host reads and moderates.
        case billingRetry = "billing_retry"
        /// Ended: the host can download until `readonlyUntil`.
        case lapsed
        /// Refunded: like lapsed, with a shorter download window.
        case revoked
    }

    /// Events the host can create right now, by kind.
    public struct EventsLeft: Sendable, Hashable {
        public let main: Int
        public let test: Int

        public init(main: Int, test: Int) {
            self.main = main
            self.test = test
        }
    }

    public let state: State
    /// The tier in force, e.g. `host_150`.
    public let productID: String
    /// Guests per main event on this tier.
    public let guestCap: Int
    /// A downgrade that applies at the next renewal.
    public let pendingProductID: String?
    public let periodEndsAt: Date
    /// The test event is live until then.
    public let testWindowEndsAt: Date
    public let graceEndsAt: Date?
    /// Once the plan ended: downloads stop and everything is deleted after this.
    public let readonlyUntil: Date?
    public let canEdit: Bool
    public let canModerate: Bool
    public let canDownload: Bool
    public let eventsLeft: EventsLeft

    public init(
        state: State, productID: String, guestCap: Int, pendingProductID: String?,
        periodEndsAt: Date, testWindowEndsAt: Date, graceEndsAt: Date?, readonlyUntil: Date?,
        canEdit: Bool, canModerate: Bool, canDownload: Bool, eventsLeft: EventsLeft
    ) {
        self.state = state
        self.productID = productID
        self.guestCap = guestCap
        self.pendingProductID = pendingProductID
        self.periodEndsAt = periodEndsAt
        self.testWindowEndsAt = testWindowEndsAt
        self.graceEndsAt = graceEndsAt
        self.readonlyUntil = readonlyUntil
        self.canEdit = canEdit
        self.canModerate = canModerate
        self.canDownload = canDownload
        self.eventsLeft = eventsLeft
    }
}
