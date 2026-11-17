import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Records requests and answers each with a canned status and body.
/// `@unchecked Sendable`: all mutable state is behind `lock` (`Mutex` needs iOS 18).
final class StubTransport: ClientTransport, @unchecked Sendable {
    struct Recorded {
        let request: HTTPRequest
        let baseURL: URL
        let body: String?
    }

    private let lock = NSLock()
    private var recorded: [Recorded] = []
    private let status: Int
    private let json: String
    private let contentType: String
    private let failure: (any Error)?

    init(status: Int = 200, json: String, contentType: String = "application/json") {
        self.status = status
        self.json = json
        self.contentType = contentType
        failure = nil
    }

    /// Throws `failure` instead of answering, like an offline network.
    init(failure: any Error) {
        status = 0
        json = ""
        contentType = ""
        self.failure = failure
    }

    var requests: [Recorded] { lock.withLock { recorded } }

    func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws -> (HTTPResponse, HTTPBody?) {
        let text: String? = if let body { try await String(collecting: body, upTo: 1 << 20) } else { nil }
        lock.withLock { recorded.append(Recorded(request: request, baseURL: baseURL, body: text)) }
        if let failure { throw failure }
        var fields = HTTPFields()
        fields[.contentType] = contentType
        return (HTTPResponse(status: .init(code: status), headerFields: fields), HTTPBody(json))
    }
}

enum Fixtures {
    static func media(kind: String = "image", url: String = "/media/events/e1/moments/m1.jpg") -> String {
        """
        {"kind":"\(kind)","url":"\(url)","thumb_url":"/media/events/e1/thumbs/m1.jpg","display_url":null,
         "poster_url":null,"hls_url":null,"width":1200,"height":800,"duration_ms":null,"blurhash":null}
        """
    }

    static func moment(id: String = "m1", seq: Int = 1, kind: String = "image",
                       url: String = "/media/events/e1/moments/m1.jpg", createdAt: String = "2026-11-17 18:30:00") -> String {
        """
        {"id":"\(id)","event_id":"e1","uploader_name":"Sara","media_url":"\(url)","caption":"Hi",
         "points_awarded":1,"created_at":"\(createdAt)","size_bytes":10,"mime_type":"image/jpeg","seq":\(seq),
         "change_seq":\(seq),"reaction_count":2,"reacted":true,"media":\(media(kind: kind, url: url))}
        """
    }

    static func event(accessMode: String = "public") -> String {
        """
        {"event":{"id":"e1","slug":"party","title":"Party","type":"Party","main_characters":null,
         "description":null,"cover_image_url":"/media/events/e1/cover.jpg","created_at":"2026-11-17 18:30:00",
         "starts_at":null,"expires_at":"2026-12-01 00:00:00","uploads_close_at":null,"purge_after":null,
         "archived_at":null,"access_mode":"\(accessMode)","uploads_open":true}}
        """
    }
}
