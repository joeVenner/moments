import Foundation
import MomentsDomain

/// Turns generated wire types into MomentsDomain models.
///
/// Rules: timestamps go through `ServerDate`; `/media/...` paths become
/// absolute URLs on the API origin; anything we can't read safely (unknown
/// media kind, bad date, URL on another scheme) drops that one row, never
/// the page.
struct WireMapper: Sendable {
    /// Scheme + host (+ port) the relative media paths live on.
    let origin: URL
    private let originHost: String

    /// Video hosts the server emits (`STREAM_HOST` in src/worker/streamSigning.ts).
    nonisolated(unsafe) private static let streamHost = /^customer-[a-z0-9]+\.cloudflarestream\.com$/

    /// Nil when the base URL has no usable scheme and host.
    init?(apiBaseURL: URL) {
        guard let scheme = apiBaseURL.scheme?.lowercased(), let host = apiBaseURL.host()?.lowercased(),
              !host.isEmpty, !host.contains(":")
        else { return nil }
        let port = apiBaseURL.port.map { ":\($0)" } ?? ""
        guard let origin = URL(string: "\(scheme)://\(host)\(port)") else { return nil }
        self.origin = origin
        originHost = host
    }

    /// Media links must be on our origin (`/media/...` paths are resolved
    /// there) or a Cloudflare Stream customer host over https. Everything
    /// else is refused: other hosts, userinfo, backslashes (parsers disagree
    /// on them), protocol-relative paths and other schemes. Image and video
    /// loaders can therefore trust any URL a domain model carries.
    func resolve(_ value: String) -> String? {
        // Only "/path" or a full URL; bare relative paths are never emitted.
        guard value.hasPrefix("/") || value.contains("://"),
              !value.contains("\\"), !value.hasPrefix("//"),
              let url = URL(string: value, relativeTo: origin)?.absoluteURL,
              url.user() == nil, url.password() == nil,
              let scheme = url.scheme?.lowercased(), let host = url.host()?.lowercased()
        else { return nil }
        let isSameOrigin = scheme == origin.scheme && host == originHost && url.port == origin.port
        let isStream = scheme == "https" && url.port == nil && host.wholeMatch(of: Self.streamHost) != nil
        return isSameOrigin || isStream ? url.absoluteString : nil
    }

    /// Optional URLs that fail to resolve become nil rather than dropping the row.
    func resolveOptional(_ value: String?) -> String? {
        value.flatMap(resolve)
    }

    func event(_ wire: Components.Schemas.Event) throws(MomentsAPIError) -> Event {
        guard let accessMode = Event.AccessMode(rawValue: wire.accessMode),
              let createdAt = ServerDate.parse(wire.createdAt)
        else { throw .unexpectedResponse }
        return Event(
            id: wire.id, slug: wire.slug, title: wire.title, type: wire._type,
            mainCharacters: wire.mainCharacters, description: wire.description,
            coverImageURL: resolveOptional(wire.coverImageUrl),
            createdAt: createdAt,
            startsAt: wire.startsAt.flatMap(ServerDate.parse),
            expiresAt: wire.expiresAt.flatMap(ServerDate.parse),
            uploadsCloseAt: wire.uploadsCloseAt.flatMap(ServerDate.parse),
            purgeAfter: wire.purgeAfter.flatMap(ServerDate.parse),
            archivedAt: wire.archivedAt.flatMap(ServerDate.parse),
            accessMode: accessMode,
            areUploadsOpen: wire.uploadsOpen
        )
    }

    /// Nil when the row can't be shown safely (see type docs).
    func moment(_ wire: Components.Schemas.Moment) -> Moment? {
        guard let kind = Media.Kind(rawValue: wire.media.kind),
              let url = resolve(wire.media.url),
              let createdAt = ServerDate.parse(wire.createdAt)
        else { return nil }
        let media = Media(
            kind: kind, url: url,
            thumbURL: resolveOptional(wire.media.thumbUrl),
            displayURL: resolveOptional(wire.media.displayUrl),
            posterURL: resolveOptional(wire.media.posterUrl),
            hlsURL: resolveOptional(wire.media.hlsUrl),
            width: wire.media.width, height: wire.media.height,
            durationMilliseconds: wire.media.durationMs, blurhash: wire.media.blurhash
        )
        return Moment(
            id: wire.id, eventID: wire.eventId, uploaderName: wire.uploaderName, caption: wire.caption,
            pointsAwarded: wire.pointsAwarded, createdAt: createdAt, seq: wire.seq, changeSeq: wire.changeSeq,
            reactionCount: wire.reactionCount, hasReacted: wire.reacted, media: media
        )
    }

    func participant(_ wire: Components.Schemas.Participant) throws(MomentsAPIError) -> Participant {
        guard let joinedAt = ServerDate.parse(wire.joinedAt) else { throw .unexpectedResponse }
        return Participant(
            id: wire.id, eventID: wire.eventId, nickname: wire.nickname,
            avatarSeed: wire.avatarSeed, joinedAt: joinedAt
        )
    }

    /// Rows we can't read are left out.
    func highlights(_ wire: Components.Schemas.Highlights) -> [Moment] {
        wire.moments.compactMap(moment)
    }

    func leaderboard(_ wire: Components.Schemas.Leaderboard) -> [LeaderboardEntry] {
        wire.entries.map {
            LeaderboardEntry(
                participantID: $0.participantId, nickname: $0.nickname, avatarSeed: $0.avatarSeed,
                totalPoints: max(0, $0.totalPoints), momentCount: max(0, $0.momentCount), rank: max(1, $0.rank)
            )
        }
    }

    func feedPage(_ wire: Components.Schemas.FeedPage) -> FeedPage {
        let moments = wire.moments.compactMap(moment)
        return FeedPage(
            moments: moments, nextBefore: wire.nextBefore, cursor: wire.cursor,
            skippedCount: wire.moments.count - moments.count
        )
    }

    /// A row we can't read is reported as removed, so an older readable copy
    /// already on screen doesn't linger out of date.
    func feedChanges(_ wire: Components.Schemas.FeedChanges) -> FeedChanges {
        var upserts: [Moment] = []
        var removed = wire.removed
        for row in wire.upserts {
            if let mapped = moment(row) { upserts.append(mapped) } else { removed.append(row.id) }
        }
        return FeedChanges(
            upserts: upserts, removed: removed, cursor: wire.cursor, hasMore: wire.hasMore,
            skippedCount: wire.upserts.count - upserts.count
        )
    }
}
