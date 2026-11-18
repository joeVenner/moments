import Foundation
import MomentsAPI
import MomentsDomain

/// Sends parts straight to storage with presigned PUT URLs, while the app
/// runs (the App Clip can't use a background session; the full app uses
/// `BackgroundPartUploader`). Each part is copied from the checked
/// staged-file handle into a part file in the staging area's parts folder,
/// uploaded and deleted.
///
/// Storage is a different trust zone from the API: requests carry no API
/// headers (the URL is the credential), redirects are refused (a redirect
/// would carry the bytes elsewhere), and every URL passes `StorageTarget`'s
/// rules.
///
/// Parts go one at a time. Call `invalidate()` when done with it.
public final class URLSessionPartUploader: PartUploader, Sendable {
    private let service: any UploadService
    private let staging: StagingArea
    private let hosts: StorageHostPolicy
    private let session: URLSession
    private let pins = Pins()

    public init(
        service: any UploadService, staging: StagingArea, hosts: StorageHostPolicy,
        configuration: URLSessionConfiguration = .ephemeral
    ) {
        self.service = service
        self.staging = staging
        self.hosts = hosts
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        // The delegate holds nothing, so the session doesn't keep the
        // uploader alive.
        session = URLSession(configuration: configuration, delegate: RedirectRefuser(), delegateQueue: nil)
    }

    /// Cancels uploads in flight and releases the session.
    public func invalidate() {
        session.invalidateAndCancel()
    }

    /// Nothing outlives this uploader's process, so every part file left at
    /// launch is from a crash (photo bytes) and goes.
    public func recover() async throws {
        try staging.clearPartFiles()
    }

    public func upload(
        parts: [Int], session ref: QueuedUpload.SessionRef, item: QueuedUpload, file: FileHandle,
        credentials: EventCredentials
    ) async throws -> Set<Int> {
        let parts = Array(Set(parts)).sorted()
        guard !parts.isEmpty else { return [] }
        let batch = try await service.partURLs(slug: item.eventSlug, uploadID: ref.id, parts: parts, credentials: credentials)
        let targets = try StorageTarget.checked(batch, parts: parts, hosts: hosts, pins: pins, sessionID: ref.id)
        var sent: Set<Int> = []
        for (number, url) in targets {
            do {
                try Task.checkCancellation()
                try await send(part: number, of: ref, item: item, file: file, to: url)
                sent.insert(number)
            } catch {
                // Parts already sent are progress the queue should record;
                // the rest is retried. A refusal of the file itself, or
                // nothing sent at all, is reported as the error.
                if sent.isEmpty || !StorageTarget.isRetryable(error) { throw error }
                return sent
            }
        }
        return sent
    }

    private func send(part number: Int, of ref: QueuedUpload.SessionRef, item: QueuedUpload, file: FileHandle, to url: URL) async throws {
        guard let range = UploadPlan.byteRange(part: number, size: item.file.size, partSize: ref.partSize) else {
            throw MomentsAPIError.invalidUpload
        }
        let partURL: URL
        do throws(StagingArea.Problem) {
            partURL = try staging.partsFolder().appending(path: "\(item.id.uuidString)-\(number)-\(UUID().uuidString)")
        } catch {
            throw MomentsAPIError.transport(nil)
        }
        do throws(PartFile.Problem) {
            try PartFile.write(from: file, range: range, to: partURL)
        } catch .shortRead {
            throw MomentsAPIError.invalidUpload
        } catch {
            throw MomentsAPIError.transport(nil)
        }
        defer { unlink(partURL.path(percentEncoded: false)) }

        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let response: URLResponse
        do {
            (_, response) = try await session.upload(for: request, fromFile: partURL, delegate: TaskLabel(item: item.id, part: number))
        } catch let error as URLError {
            throw MomentsAPIError.transport(error.code)
        }
        try StorageTarget.check(response)
    }
}

/// Labels a task by item and part only: never the URL (a credential) or
/// anything about the file. Refuses redirects too, as task delegates are
/// asked first.
private final class TaskLabel: NSObject, URLSessionTaskDelegate, Sendable {
    let label: String
    init(item: UUID, part: Int) { label = "\(item.uuidString):\(part)" }

    func urlSession(_ session: URLSession, didCreateTask task: URLSessionTask) {
        task.taskDescription = label
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}
