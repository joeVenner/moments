import Foundation

/// Domain models used by the app's screens. The generated API client
/// (MomentsAPI, next phase) maps its wire types into these: timestamps via
/// `ServerDate`, relative `/media/...` paths resolved against the API origin.
/// An unknown enum value from a newer server is the mapper's call (skip the
/// row), never a reason to drop a whole page.

public struct Event: Sendable, Hashable, Identifiable {
    public enum AccessMode: String, Sendable, Hashable {
        case `public`, `private`
    }

    public let id: String
    public let slug: String
    public let title: String
    public let type: String
    public let mainCharacters: String?
    public let description: String?
    public let coverImageURL: String?
    public let createdAt: Date
    public let startsAt: Date?
    /// Legacy single end date; the two below fall back to it when nil.
    public let expiresAt: Date?
    public let uploadsCloseAt: Date?
    public let purgeAfter: Date?
    public let archivedAt: Date?
    public let accessMode: AccessMode
    /// Server-computed at response time; prefer it over comparing dates locally.
    public let areUploadsOpen: Bool

    /// When new uploads stop, after applying the server's expires_at fallback.
    public var effectiveUploadsCloseAt: Date? { uploadsCloseAt ?? expiresAt }
    /// When the event and its media are deleted, after the same fallback.
    public var effectivePurgeAfter: Date? { purgeAfter ?? expiresAt }

    public init(
        id: String, slug: String, title: String, type: String,
        mainCharacters: String? = nil, description: String? = nil, coverImageURL: String? = nil,
        createdAt: Date, startsAt: Date? = nil, expiresAt: Date? = nil, uploadsCloseAt: Date? = nil,
        purgeAfter: Date? = nil, archivedAt: Date? = nil, accessMode: AccessMode = .public, areUploadsOpen: Bool = true
    ) {
        self.id = id
        self.slug = slug
        self.title = title
        self.type = type
        self.mainCharacters = mainCharacters
        self.description = description
        self.coverImageURL = coverImageURL
        self.createdAt = createdAt
        self.startsAt = startsAt
        self.expiresAt = expiresAt
        self.uploadsCloseAt = uploadsCloseAt
        self.purgeAfter = purgeAfter
        self.archivedAt = archivedAt
        self.accessMode = accessMode
        self.areUploadsOpen = areUploadsOpen
    }
}

/// One guest's place on the event leaderboard.
public struct LeaderboardEntry: Sendable, Hashable, Identifiable {
    public let participantID: String
    public let nickname: String
    public let avatarSeed: String?
    public let totalPoints: Int
    public let momentCount: Int
    /// 1-based; guests with equal points share a rank (1, 1, 3).
    public let rank: Int

    public var id: String { participantID }

    public init(participantID: String, nickname: String, avatarSeed: String? = nil, totalPoints: Int, momentCount: Int, rank: Int) {
        self.participantID = participantID
        self.nickname = nickname
        self.avatarSeed = avatarSeed
        self.totalPoints = totalPoints
        self.momentCount = momentCount
        self.rank = rank
    }
}

public struct Participant: Sendable, Hashable, Identifiable {
    public let id: String
    public let eventID: String
    public let nickname: String
    public let avatarSeed: String?
    public let joinedAt: Date

    public init(id: String, eventID: String, nickname: String, avatarSeed: String? = nil, joinedAt: Date) {
        self.id = id
        self.eventID = eventID
        self.nickname = nickname
        self.avatarSeed = avatarSeed
        self.joinedAt = joinedAt
    }
}

public struct Media: Sendable, Hashable {
    public enum Kind: String, Sendable, Hashable {
        case image, video
    }

    public let kind: Kind
    /// Original. `/media/...` paths are relative to the API origin.
    public let url: String
    public let thumbURL: String?
    public let displayURL: String?
    public let posterURL: String?
    public let hlsURL: String?
    public let width: Int?
    public let height: Int?
    public let durationMilliseconds: Int?
    public let blurhash: String?

    public init(
        kind: Kind, url: String, thumbURL: String? = nil, displayURL: String? = nil, posterURL: String? = nil,
        hlsURL: String? = nil, width: Int? = nil, height: Int? = nil, durationMilliseconds: Int? = nil, blurhash: String? = nil
    ) {
        self.kind = kind
        self.url = url
        self.thumbURL = thumbURL
        self.displayURL = displayURL
        self.posterURL = posterURL
        self.hlsURL = hlsURL
        self.width = width
        self.height = height
        self.durationMilliseconds = durationMilliseconds
        self.blurhash = blurhash
    }

    /// Width / height when both are known and positive; layouts fall back to square.
    public var aspectRatio: Double? {
        guard let width, let height, width > 0, height > 0 else { return nil }
        return Double(width) / Double(height)
    }

    /// Images a grid cell can show, smallest first: the thumbnail, then a
    /// larger still for when it is missing or broken (a photo's display
    /// rendition or original, a video's poster). Never a video file.
    public var gridImageURLs: [String] {
        let fallback = kind == .video ? posterURL : displayURL ?? url
        var urls: [String] = []
        for candidate in [thumbURL, fallback].compactMap(\.self) where !urls.contains(candidate) {
            urls.append(candidate)
        }
        return urls
    }

    /// Best still for the full-screen viewer: the display rendition, else the
    /// original photo, else a video's poster.
    public var viewerImageURL: String? {
        displayURL ?? (kind == .image ? url : posterURL ?? thumbURL)
    }

    /// What a player can open: Stream's HLS manifest, or an R2 video file.
    /// A Stream original is an embed page, never playable directly.
    public var playbackURL: String? {
        guard kind == .video else { return nil }
        let candidate = hlsURL ?? (Self.isStreamEmbed(url) ? nil : url)
        // Only absolute web URLs reach a player (the API client resolves ours).
        guard let candidate, let scheme = URL(string: candidate)?.scheme?.lowercased(),
              scheme == "https" || scheme == "http"
        else { return nil }
        return candidate
    }

    static func isStreamEmbed(_ url: String) -> Bool {
        guard let host = URL(string: url)?.host()?.lowercased() else { return false }
        return host.hasSuffix(".cloudflarestream.com") || host == "iframe.videodelivery.net"
    }
}

/// Omits the wire's `media_url` (same as `media.url`), `size_bytes` and
/// `mime_type` (`media.kind` covers what screens need).
public struct Moment: Sendable, Hashable, Identifiable {
    public let id: String
    public let eventID: String
    public let uploaderName: String
    public let caption: String?
    public let pointsAwarded: Int
    public let createdAt: Date
    /// Feed order; newest has the highest.
    public let seq: Int
    /// Bumps on every change (reaction, hide); drives incremental sync.
    public let changeSeq: Int
    public internal(set) var reactionCount: Int
    /// Whether this device's guest has reacted. Mutated only through `FeedState`.
    public internal(set) var hasReacted: Bool
    public let media: Media

    public init(
        id: String, eventID: String, uploaderName: String, caption: String? = nil, pointsAwarded: Int,
        createdAt: Date, seq: Int, changeSeq: Int, reactionCount: Int = 0, hasReacted: Bool = false, media: Media
    ) {
        self.id = id
        self.eventID = eventID
        self.uploaderName = uploaderName
        self.caption = caption
        self.pointsAwarded = pointsAwarded
        self.createdAt = createdAt
        self.seq = seq
        self.changeSeq = changeSeq
        self.reactionCount = reactionCount
        self.hasReacted = hasReacted
        self.media = media
    }
}
