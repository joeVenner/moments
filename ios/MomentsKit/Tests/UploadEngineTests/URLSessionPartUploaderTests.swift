import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import UploadEngine

private let accountID = "0123456789abcdef0123456789abcdef"

/// Answers storage requests in tests and records what was sent.
final class StorageStub: URLProtocol, @unchecked Sendable {
    struct Sent: Sendable {
        let url: URL
        let method: String?
        let headers: [String: String]
        let body: Data
    }

    nonisolated(unsafe) static var respond: @Sendable (URLRequest) -> (Int, [String: String]) = { _ in (200, ["ETag": "\"e\""]) }
    nonisolated(unsafe) static var sent: [Sent] = []
    static let lock = NSLock()

    static func reset() {
        lock.withLock {
            sent = []
            respond = { _ in (200, ["ETag": "\"e\""]) }
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 64 * 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(buffer, count: count)
            }
            stream.close()
        } else if let data = request.httpBody {
            body = data
        }
        let (status, headers) = Self.lock.withLock {
            Self.sent.append(Sent(url: request.url!, method: request.httpMethod, headers: request.allHTTPHeaderFields ?? [:], body: body))
            return Self.respond(request)
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Hands out part URLs on a chosen host.
final class PartURLService: UploadService, @unchecked Sendable {
    var host = "\(accountID).r2.cloudflarestorage.com"
    /// Per-part host overrides.
    var hosts: [Int: String] = [:]
    private(set) var requested: [[Int]?] = []

    func partURLs(slug: String, uploadID: String, parts: [Int]?, credentials: EventCredentials) async throws -> PartURLBatch {
        requested.append(parts)
        var urls: [Int: URL] = [:]
        for part in parts ?? [] {
            urls[part] = URL(string: "https://\(hosts[part] ?? host)/bucket/key?partNumber=\(part)&X-Amz-Signature=sig")!
        }
        return PartURLBatch(expiresAt: .distantFuture, urls: urls)
    }

    func startUpload(_ upload: NewUpload, slug: String, credentials: EventCredentials) async throws -> UploadSession { fatalError() }
    func uploadProgress(slug: String, uploadID: String, credentials: EventCredentials) async throws -> UploadProgress { fatalError() }
    func completeUpload(slug: String, uploadID: String, credentials: EventCredentials) async throws -> CompleteOutcome { fatalError() }
    func abortUpload(slug: String, uploadID: String, credentials: EventCredentials) async throws -> UploadSession { fatalError() }
}

/// Parts are 5 bytes here, so a 12-byte file has three.
private struct Setup {
    let folder: TempFolder
    let staging: StagingArea
    let service = PartURLService()
    let item: QueuedUpload
    let bytes = Data("abcdefghijkl".utf8)
    let ref = QueuedUpload.SessionRef(id: "u1", partSize: 5, partCount: 3)

    init() throws {
        folder = try TempFolder()
        staging = StagingArea(root: folder.url)
        let id = UUID()
        try FileManager.default.createDirectory(at: staging.folder(for: id), withIntermediateDirectories: true)
        try bytes.write(to: staging.folder(for: id).appending(path: "a.jpg"))
        item = QueuedUpload(
            id: id, eventSlug: "party",
            file: .init(relativePath: StagingArea.relativePath(for: id, name: "a.jpg"), size: 12, contentType: "image/jpeg")!,
            caption: nil, createdAt: Date()
        )
        StorageStub.reset()
    }

    func uploader() -> URLSessionPartUploader {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StorageStub.self]
        return URLSessionPartUploader(service: service, staging: staging, hosts: .r2Account(accountID)!, configuration: configuration)
    }

    func upload(_ parts: [Int], with uploader: URLSessionPartUploader? = nil) async throws -> Set<Int> {
        let file = try staging.open(item.file, owner: item.id)
        return try await (uploader ?? self.uploader()).upload(
            parts: parts, session: ref, item: item, file: file, credentials: EventCredentials(accessGrant: "grant-test", guestToken: "gt-test")
        )
    }

    /// Files left in the item's folder besides the staged file, and part
    /// files.
    func leftovers() throws -> [String] {
        let parts = (try? FileManager.default.contentsOfDirectory(atPath: staging.root.appending(path: ".parts").path())) ?? []
        return try FileManager.default.contentsOfDirectory(atPath: staging.folder(for: item.id).path()).filter { $0 != "a.jpg" } + parts
    }
}

@Suite(.serialized) struct URLSessionPartUploaderTests {
    @Test func putsEachPartsBytesWithoutAPIHeaders() async throws {
        let setup = try Setup()
        #expect(try await setup.upload([1, 2, 3]) == [1, 2, 3])
        #expect(setup.service.requested == [[1, 2, 3]])
        let sent = StorageStub.sent
        #expect(sent.map(\.body) == [Data("abcde".utf8), Data("fghij".utf8), Data("kl".utf8)])
        #expect(sent.allSatisfy { $0.method == "PUT" })
        for request in sent {
            let names = request.headers.keys.map { $0.lowercased() }
            #expect(!names.contains("authorization") && !names.contains("x-guest-token") && !names.contains("x-access-grant"))
            #expect(!names.contains { $0.hasPrefix("x-amz-") })
        }
        #expect(try setup.leftovers().isEmpty)
    }

    @Test func reportsPartsSentBeforeAFailure() async throws {
        let setup = try Setup()
        StorageStub.respond = { request in
            request.url!.query()!.contains("partNumber=2") ? (500, [:]) : (200, ["ETag": "\"e\""])
        }
        #expect(try await setup.upload([1, 2, 3]) == [1])
        #expect(StorageStub.sent.count == 2)
        #expect(try setup.leftovers().isEmpty)
    }

    @Test func throwsWhenNothingWasSent() async throws {
        let setup = try Setup()
        StorageStub.respond = { _ in (200, [:]) } // no ETag: not a receipt
        await #expect(throws: MomentsAPIError.unexpectedResponse) { try await setup.upload([1]) }
        StorageStub.respond = { _ in (403, [:]) }
        await #expect(throws: MomentsAPIError.storageUnavailable) { try await setup.upload([1]) }
    }

    @Test(arguments: [
        (200, MomentsAPIError?.none), (302, .unexpectedResponse), (400, .storageUnavailable), (403, .storageUnavailable),
        (404, .uploadNotOpen), (408, .storageUnavailable), (411, .invalidUpload), (413, .invalidUpload),
        (418, .unexpectedResponse), (429, .storageUnavailable), (503, .storageUnavailable),
    ])
    func mapsStorageAnswers(status: Int, error: MomentsAPIError?) {
        let response = HTTPURLResponse(
            url: URL(string: "https://s.example.com")!, statusCode: status, httpVersion: nil, headerFields: ["ETag": "\"e\""]
        )!
        if let error {
            #expect(throws: error) { try URLSessionPartUploader.check(response) }
        } else {
            #expect(throws: Never.self) { try URLSessionPartUploader.check(response) }
        }
    }

    @Test(arguments: [
        ("https://acct.r2.cloudflarestorage.com/b/k", "acct.r2.cloudflarestorage.com"),
        ("https://ACCT.R2.cloudflarestorage.com/b/k", "acct.r2.cloudflarestorage.com"),
        ("http://acct.r2.cloudflarestorage.com/b/k", nil), ("https://127.0.0.1/b", nil), ("https://[::1]/b", nil),
        ("https://2130706433/b", nil), ("https://0x7f000001/b", nil), ("https://0x7f.0.0.1/b", nil),
        ("https://0177.0.0.1/b", nil), ("https://1.2.3.0x4/b", nil),
        ("https://localhost/b", nil), ("https://a.localhost/b", nil), ("https://user:pw@s.example.com/b", nil),
        ("https://10.0.0.1./b", nil), ("https://nas/b", nil), ("https://printer.local/b", nil),
        ("https://metadata.internal/b", nil), ("https://s.example.com./b", nil), ("https://nas.home/b", nil),
        ("https://box.lan/b", nil), ("https://s.example.com%2eevil.com/b", "s.example.com.evil.com"),
        ("https://%61cct.example.com/b", "acct.example.com"),
    ])
    func acceptsOnlyNamedHttpsHosts(url: String, host: String?) {
        #expect(URLSessionPartUploader.storageHost(of: URL(string: url)!) == host)
    }

    @Test func allowsOnlyOurStorageAccount() throws {
        let policy = try #require(StorageHostPolicy.r2Account(accountID.uppercased()))
        #expect(policy.allows("\(accountID).r2.cloudflarestorage.com"))
        // Another R2 customer's account, the shared parent, lookalikes.
        #expect(!policy.allows("ffffffffffffffffffffffffffffffff.r2.cloudflarestorage.com"))
        #expect(!policy.allows("r2.cloudflarestorage.com"))
        #expect(!policy.allows("x\(accountID).r2.cloudflarestorage.com"))
        #expect(!policy.allows("\(accountID).r2.cloudflarestorage.com.example.com"))
        #expect(StorageHostPolicy.r2Account("not-an-account") == nil)
    }

    @Test func refusesURLsForAnotherPartOrHost() async throws {
        let setup = try Setup()
        setup.service.host = "attacker.example.com"
        await #expect(throws: MomentsAPIError.unexpectedResponse) { try await setup.upload([1]) }
        #expect(URLSessionPartUploader.partNumber(in: URL(string: "https://s.example.com/k?partNumber=2&partNumber=3")!) == nil)
        #expect(URLSessionPartUploader.partNumber(in: URL(string: "https://s.example.com/k?partNumber=2")!) == 2)
        #expect(URLSessionPartUploader.partNumber(in: URL(string: "https://s.example.com/partNumber=2/k")!) == nil)
        #expect(URLSessionPartUploader.partNumber(in: URL(string: "https://s.example.com/k#partNumber=2")!) == nil)
        #expect(StorageStub.sent.isEmpty)
    }

    @Test func rethrowsARefusalEvenAfterProgress() async throws {
        let setup = try Setup()
        StorageStub.respond = { request in
            request.url!.query()!.contains("partNumber=2") ? (413, [:]) : (200, ["ETag": "\"e\""])
        }
        await #expect(throws: MomentsAPIError.invalidUpload) { try await setup.upload([1, 2, 3]) }
    }

    @Test func clearsPartFilesLeftByACrash() throws {
        let setup = try Setup()
        let folder = try setup.staging.partsFolder()
        try Data("photo".utf8).write(to: folder.appending(path: "left"))
        #expect(try folder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        try setup.staging.clearPartFiles()
        #expect(try setup.leftovers().isEmpty)
        try setup.staging.clearPartFiles()
    }

    @Test func clearingRemovesALinkedPartsFolderNotItsTarget() throws {
        let setup = try Setup()
        let target = setup.folder.url.appending(path: "elsewhere")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        try Data("keep".utf8).write(to: target.appending(path: "f"))
        try FileManager.default.createSymbolicLink(at: setup.staging.root.appending(path: ".parts"), withDestinationURL: target)
        try setup.staging.clearPartFiles()
        #expect(FileManager.default.fileExists(atPath: target.appending(path: "f").path()))
        #expect((try? FileManager.default.destinationOfSymbolicLink(atPath: setup.staging.root.appending(path: ".parts").path())) == nil)
    }

    @Test func refusesAPartsFolderThatIsALink() throws {
        let setup = try Setup()
        try FileManager.default.createSymbolicLink(
            at: setup.staging.root.appending(path: ".parts"), withDestinationURL: setup.folder.url.appending(path: "elsewhere")
        )
        try FileManager.default.createDirectory(at: setup.folder.url.appending(path: "elsewhere"), withIntermediateDirectories: true)
        #expect(throws: StagingArea.Problem.outsideStaging) { try setup.staging.partsFolder() }
    }

    @Test func pinsTheFirstHostOfASession() async throws {
        let setup = try Setup()
        let uploader = setup.uploader()
        #expect(try await setup.upload([1], with: uploader) == [1])
        setup.service.host = "other.\(accountID).r2.cloudflarestorage.com"
        await #expect(throws: MomentsAPIError.unexpectedResponse) { try await setup.upload([2], with: uploader) }
        // Nor within one batch.
        setup.service.host = "\(accountID).r2.cloudflarestorage.com"
        setup.service.hosts = [3: "other.\(accountID).r2.cloudflarestorage.com"]
        await #expect(throws: MomentsAPIError.unexpectedResponse) { try await setup.upload([2, 3], with: uploader) }
        #expect(StorageStub.sent.count == 1)
    }

    @Test func refusesRedirects() async throws {
        let setup = try Setup()
        let uploader = RedirectRefuser()
        let task = URLSession.shared.dataTask(with: URL(string: "https://s.example.com")!)
        let response = HTTPURLResponse(url: URL(string: "https://s.example.com")!, statusCode: 307, httpVersion: nil, headerFields: nil)!
        let next = await uploader.urlSession(
            URLSession.shared, task: task, willPerformHTTPRedirection: response,
            newRequest: URLRequest(url: URL(string: "https://evil.example.com")!)
        )
        #expect(next == nil)
    }

    @Test func failsAPartWhenTheFileIsShort() async throws {
        let setup = try Setup()
        let file = try setup.staging.open(setup.item.file, owner: setup.item.id)
        // Shrunk on disk after the queue checked it.
        let writer = try FileHandle(forWritingTo: setup.staging.root.appending(path: setup.item.file.relativePath))
        try writer.truncate(atOffset: 7)
        try writer.close()
        await #expect(throws: MomentsAPIError.invalidUpload) {
            try await setup.uploader().upload(
                parts: [2], session: setup.ref, item: setup.item, file: file, credentials: EventCredentials()
            )
        }
        #expect(StorageStub.sent.isEmpty)
        #expect(try setup.leftovers().isEmpty)
    }
}

@Suite struct PartFileTests {
    @Test func copiesTheRangeAndRefusesExistingFiles() throws {
        let folder = try TempFolder()
        let source = folder.url.appending(path: "s")
        try Data("0123456789".utf8).write(to: source)
        let handle = try FileHandle(forReadingFrom: source)
        let part = folder.url.appending(path: "p")
        try PartFile.write(from: handle, range: 3 ..< 8, to: part)
        #expect(try Data(contentsOf: part) == Data("34567".utf8))
        #expect(throws: PartFile.Problem.writeFailed) { try PartFile.write(from: handle, range: 0 ..< 1, to: part) }
        #expect(throws: PartFile.Problem.shortRead) { try PartFile.write(from: handle, range: 8 ..< 12, to: folder.url.appending(path: "q")) }
        #expect(!FileManager.default.fileExists(atPath: folder.url.appending(path: "q").path()))
    }
}
