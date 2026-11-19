import Foundation

/// An event as the host's list shows it.
public struct AdminEvent: Sendable, Hashable, Identifiable {
    public let event: Event
    /// Every moment, hidden ones included.
    public let momentCount: Int
    /// Guests currently in the event.
    public let participantCount: Int

    public var id: String { event.id }

    public init(event: Event, momentCount: Int, participantCount: Int) {
        self.event = event
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
