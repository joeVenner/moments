import Foundation
import UploadEngine

/// The upload screen's `UploadSubmitting`, backed by the app's `UploadQueue`.
public struct QueueSubmitter: UploadSubmitting {
    private let isReady: @Sendable () async -> Bool
    private let enqueue: @Sendable (QueuedUpload) async throws -> Void

    /// `isReady` waits for the launch load and says whether it worked: a
    /// guest sharing in the first moments waits for it instead of failing.
    public init(queue: UploadQueue, isReady: @escaping @Sendable () async -> Bool) {
        self.isReady = isReady
        enqueue = { try await queue.enqueue($0) }
    }

    /// Any enqueue (tests script the queue's answers).
    init(isReady: @escaping @Sendable () async -> Bool = { true }, enqueue: @escaping @Sendable (QueuedUpload) async throws -> Void) {
        self.isReady = isReady
        self.enqueue = enqueue
    }

    public func submit(_ upload: QueuedUpload) async -> SubmitResult {
        // The saved queue couldn't be read this launch: nothing can be added.
        guard await isReady() else { return .failed }
        do {
            try await enqueue(upload)
            return .accepted
        } catch let error as UploadQueue.EnqueueError {
            return Self.result(for: error)
        } catch {
            // The record couldn't be saved (disk full, I/O): worth another try.
            return .failed
        }
    }

    /// What each queue refusal means to the guest.
    static func result(for error: UploadQueue.EnqueueError) -> SubmitResult {
        switch error {
        case .duplicate: .duplicate
        case .full: .full
        // Locked phone or a passing I/O error: the file may be readable soon.
        case .file(.unreadable): .failed
        // Gone, moved, replaced or changed: this file will never upload.
        case .file(.missing), .file(.outsideStaging), .file(.notAFile), .file(.sizeChanged): .invalid
        // Unreachable after `isReady` (the launch load finished); kept total.
        case .notLoaded, .alreadyLoaded: .failed
        }
    }
}
