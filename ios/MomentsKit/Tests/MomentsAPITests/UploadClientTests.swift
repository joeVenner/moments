import Foundation
import HTTPTypes
import Testing
@testable import MomentsAPI
import MomentsDomain

private let base = URL(string: "https://moments.test")!
private let guest = EventCredentials(accessGrant: "grant-1", guestToken: "guest-1")

private func client(_ transport: StubTransport) throws -> MomentsClient {
    try MomentsClient(baseURL: base, identity: ClientIdentity(version: "1.0.0", build: "1"), transport: transport)
}

private func session(status: String = "open", momentID: String = "null", completedAt: String = "null") -> String {
    """
    {"id":"u1","client_upload_id":"6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b","status":"\(status)",
     "content_type":"image/jpeg","size":16777316,"part_size":8388608,"part_count":3,
     "created_at":"2026-11-18 10:00:00","completed_at":\(completedAt),"moment_id":\(momentID)}
    """
}

/// The request body as a JSON object (the client pretty-prints it).
private func json(_ body: String?) throws -> [String: Any] {
    let data = try #require(body?.data(using: .utf8))
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

@Suite struct UploadClientTests {
    @Test(arguments: [200, 201])
    func startsAnUploadWithALowercasedClientID(status: Int) async throws {
        let stub = StubTransport(status: status, json: session())
        let id = UUID(uuidString: "6F1C2A7E-3B4D-4E5F-8A9B-0C1D2E3F4A5B")!
        let result = try await client(stub).startUpload(
            NewUpload(clientUploadID: id, contentType: "image/jpeg", size: 16_777_316, caption: "Cake"),
            slug: "party", credentials: guest
        )
        #expect(result.status == .open)
        #expect(result.clientUploadID == id)
        #expect(result.partSize == 8_388_608 && result.partCount == 3 && result.size == 16_777_316)
        let request = try #require(stub.requests.first)
        #expect(request.request.method == .post)
        #expect(request.request.path == "/events/party/uploads")
        #expect(request.request.headerFields[HTTPField.Name("X-Guest-Token")!] == "guest-1")
        let body = try json(request.body)
        #expect(body["client_upload_id"] as? String == "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b")
        #expect(body["caption"] as? String == "Cake")
        #expect(body["size"] as? Int == 16_777_316)
    }

    @Test func readsProgress() async throws {
        let stub = StubTransport(json: #"{"upload":\#(session()),"uploaded_parts":[1,3]}"#)
        let progress = try await client(stub).uploadProgress(slug: "party", uploadID: "u1", credentials: guest)
        #expect(progress.uploadedParts == [1, 3])
        #expect(try #require(stub.requests.first).request.path == "/events/party/uploads/u1")
    }

    @Test func fetchesPartURLs() async throws {
        let stub = StubTransport(json: """
        {"expires_at":"2026-11-18 16:00:00","parts":[{"part_number":2,"url":"https://acct.r2.cloudflarestorage.com/b/k?partNumber=2&X-Amz-Signature=s"}]}
        """)
        let batch = try await client(stub).partURLs(slug: "party", uploadID: "u1", parts: [2], credentials: guest)
        #expect(batch.urls[2]?.host() == "acct.r2.cloudflarestorage.com")
        #expect(batch.expiresAt == ServerDate.parse("2026-11-18 16:00:00"))
        let request = try #require(stub.requests.first)
        #expect(request.request.path == "/events/party/uploads/u1/part-urls")
        #expect(try json(request.body)["part_numbers"] as? [Int] == [2])
    }

    @Test(arguments: [
        "http://acct.r2.cloudflarestorage.com/b/k",
        "https://user:pw@acct.r2.cloudflarestorage.com/b/k",
        "file:///etc/passwd",
        "not a url",
    ])
    func refusesUnsafePartURLs(url: String) async throws {
        let stub = StubTransport(json: #"{"expires_at":"2026-11-18 16:00:00","parts":[{"part_number":1,"url":"\#(url)"}]}"#)
        await #expect(throws: MomentsAPIError.unexpectedResponse) {
            _ = try await client(stub).partURLs(slug: "party", uploadID: "u1", parts: nil, credentials: guest)
        }
    }

    @Test(arguments: [
        // Not requested, duplicated, out of range, or missing one asked for.
        (#"[{"part_number":3,"url":"https://r2.test/a"}]"#, [2] as [Int]?),
        (#"[{"part_number":2,"url":"https://r2.test/a"},{"part_number":2,"url":"https://r2.test/b"}]"#, [2]),
        (#"[{"part_number":0,"url":"https://r2.test/a"}]"#, nil),
        (#"[{"part_number":2,"url":"https://r2.test/a"}]"#, [2, 3]),
        (#"[{"part_number":1,"url":"https:///no-host"}]"#, nil),
    ])
    func refusesPartBatchesThatDontMatchTheRequest(parts: String, requested: [Int]?) async throws {
        let stub = StubTransport(json: #"{"expires_at":"2026-11-18 16:00:00","parts":\#(parts)}"#)
        await #expect(throws: MomentsAPIError.unexpectedResponse) {
            _ = try await client(stub).partURLs(slug: "party", uploadID: "u1", parts: requested, credentials: guest)
        }
    }

    @Test func fetchesAThumbnailURLAndNeverShowsIt() async throws {
        let stub = StubTransport(json: """
        {"expires_at":"2026-11-18 16:00:00","url":"https://acct.r2.cloudflarestorage.com/b/k.thumb-upload.jpg?X-Amz-Signature=secret"}
        """)
        let target = try await client(stub).thumbnailURL(slug: "party", uploadID: "u1", size: 1234, credentials: guest)
        #expect(target.url.host() == "acct.r2.cloudflarestorage.com")
        #expect(!String(describing: target).contains("secret") && !String(reflecting: target).contains("secret"))
        let request = try #require(stub.requests.first)
        #expect(request.request.path == "/events/party/uploads/u1/thumbnail-url")
        #expect(request.request.headerFields[HTTPField.Name("X-Guest-Token")!] == "guest-1")
        #expect(try json(request.body)["size"] as? Int == 1234)
    }

    @Test(arguments: ["http://r2.test/a", "https://user:pw@r2.test/a", "file:///etc/passwd", "https:///no-host"])
    func refusesUnsafeThumbnailURLs(url: String) async throws {
        let stub = StubTransport(json: #"{"expires_at":"2026-11-18 16:00:00","url":"\#(url)"}"#)
        await #expect(throws: MomentsAPIError.unexpectedResponse) {
            _ = try await client(stub).thumbnailURL(slug: "party", uploadID: "u1", size: 10, credentials: guest)
        }
    }

    @Test(arguments: [0, ThumbnailURL.maxSize + 1])
    func neverAsksForAThumbnailOfAnImpossibleSize(size: Int) async throws {
        let stub = StubTransport(json: "{}")
        await #expect(throws: MomentsAPIError.invalidRequest) {
            _ = try await client(stub).thumbnailURL(slug: "party", uploadID: "u1", size: size, credentials: guest)
        }
        #expect(stub.requests.isEmpty)
    }

    @Test func omitsThePartListWhenAskingForAll() async throws {
        let stub = StubTransport(json: #"{"expires_at":"2026-11-18 16:00:00","parts":[{"part_number":1,"url":"HTTPS://r2.test/a"}]}"#)
        #expect(try await client(stub).partURLs(slug: "p", uploadID: "u1", parts: nil, credentials: guest).urls.count == 1)
        #expect(try json(stub.requests.first?.body)["part_numbers"] == nil)
    }

    @Test(arguments: [
        session().replacingOccurrences(of: #""part_count":3"#, with: #""part_count":4"#),
        session().replacingOccurrences(of: #""part_size":8388608"#, with: #""part_size":0"#),
        session().replacingOccurrences(of: "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b", with: "not-a-uuid"),
    ])
    func refusesInconsistentSessions(json: String) async throws {
        await #expect(throws: MomentsAPIError.unexpectedResponse) {
            _ = try await client(StubTransport(json: json)).abortUpload(slug: "p", uploadID: "u1", credentials: guest)
        }
    }

    @Test func dropsUploadedPartsOutsideTheSession() async throws {
        let stub = StubTransport(json: #"{"upload":\#(session()),"uploaded_parts":[1,9,0]}"#)
        #expect(try await client(stub).uploadProgress(slug: "p", uploadID: "u1", credentials: guest).uploadedParts == [1])
    }

    @Test func mapsAnUnreadable409OnCompleteToUnexpectedResponse() async throws {
        await #expect(throws: MomentsAPIError.unexpectedResponse) {
            _ = try await client(StubTransport(status: 409, json: "oops")).completeUpload(slug: "p", uploadID: "u1", credentials: guest)
        }
    }

    @Test func refusesAnEmptyFileWithoutAskingTheServer() async throws {
        let stub = StubTransport(json: "{}")
        await #expect(throws: MomentsAPIError.invalidUpload) {
            _ = try await client(stub).startUpload(NewUpload(clientUploadID: UUID(), contentType: "image/jpeg", size: 0), slug: "p", credentials: guest)
        }
        #expect(stub.requests.isEmpty)
    }

    @Test func neverSendsAnEmptyPartList() async throws {
        let stub = StubTransport(json: "{}")
        await #expect(throws: MomentsAPIError.invalidRequest) {
            _ = try await client(stub).partURLs(slug: "party", uploadID: "u1", parts: [], credentials: guest)
        }
        #expect(stub.requests.isEmpty)
    }

    @Test func completes() async throws {
        let stub = StubTransport(json: session(status: "completed", momentID: #""m1""#, completedAt: #""2026-11-18 10:05:00""#))
        let outcome = try await client(stub).completeUpload(slug: "party", uploadID: "u1", credentials: guest)
        guard case let .completed(done) = outcome else { Issue.record("expected completed"); return }
        #expect(done.momentID == "m1" && done.status == .completed && done.completedAt != nil)
        let request = try #require(stub.requests.first)
        #expect(request.request.method == .post && request.request.path == "/events/party/uploads/u1/complete")
    }

    @Test func mapsCompleteOutcomes() async throws {
        let incomplete = StubTransport(status: 409, json: #"{"error":"x","code":"upload_incomplete","uploaded_parts":[1]}"#)
        #expect(try await client(incomplete).completeUpload(slug: "p", uploadID: "u1", credentials: guest) == .incomplete(uploadedParts: [1]))
        let notOpen = StubTransport(status: 409, json: #"{"error":"x","code":"upload_not_open"}"#)
        #expect(try await client(notOpen).completeUpload(slug: "p", uploadID: "u1", credentials: guest) == .notOpen)
        let rejected = StubTransport(status: 422, json: #"{"error":"x","code":"upload_rejected","reason":"signature_mismatch"}"#)
        #expect(try await client(rejected).completeUpload(slug: "p", uploadID: "u1", credentials: guest) == .rejected(.signatureMismatch))
    }

    @Test(arguments: [
        (403, "uploads_closed", MomentsAPIError.uploadsClosed),
        (403, "guest_required", .guestRequired),
        (404, "upload_not_found", .uploadNotFound),
        (409, "upload_not_open", .uploadNotOpen),
        (409, "upload_conflict", .uploadConflict),
        (429, "too_many_uploads", .tooManyUploads),
        (429, "rate_limited", .rateLimited),
        (400, "invalid_upload", .invalidUpload),
        (501, "uploads_unavailable", .uploadsUnavailable),
        (502, "storage_unavailable", .storageUnavailable),
    ])
    func mapsStartErrors(status: Int, code: String, expected: MomentsAPIError) async throws {
        let stub = StubTransport(status: status, json: #"{"error":"x","code":"\#(code)"}"#)
        await #expect(throws: expected) {
            _ = try await client(stub).startUpload(
                NewUpload(clientUploadID: UUID(), contentType: "image/jpeg", size: 1), slug: "p", credentials: guest
            )
        }
    }

    @Test func abortsAndReportsACompletedSession() async throws {
        let aborted = StubTransport(json: session(status: "aborted"))
        #expect(try await client(aborted).abortUpload(slug: "p", uploadID: "u1", credentials: guest).status == .aborted)
        #expect(try #require(aborted.requests.first).request.method == .delete)
        let done = StubTransport(status: 409, json: #"{"error":"x","code":"upload_not_open"}"#)
        await #expect(throws: MomentsAPIError.uploadNotOpen) {
            _ = try await client(done).abortUpload(slug: "p", uploadID: "u1", credentials: guest)
        }
    }

    @Test func refusesASessionWithABadDate() async throws {
        let stub = StubTransport(json: session().replacingOccurrences(of: "2026-11-18 10:00:00", with: "yesterday"))
        await #expect(throws: MomentsAPIError.unexpectedResponse) {
            _ = try await client(stub).abortUpload(slug: "p", uploadID: "u1", credentials: guest)
        }
    }

    @Test func classifiesErrorsForRetry() {
        #expect(MomentsAPIError.transport(nil).isRetryable)
        #expect(MomentsAPIError.storageUnavailable.isRetryable)
        #expect(MomentsAPIError.server(status: 503, code: nil).isRetryable)
        #expect(!MomentsAPIError.server(status: 404, code: nil).isRetryable)
        #expect(!MomentsAPIError.uploadsClosed.isRetryable)
        #expect(!MomentsAPIError.uploadNotOpen.isRetryable)
        #expect(RejectReason(rawValue: RejectReason.objectMismatch.rawValue) == .objectMismatch)
        #expect(RejectReason.unknown("x").rawValue == "x")
    }
}
