import Foundation
import MomentsAPI
import MomentsDomain
import Observation
import OSLog

/// Puts a downloaded file into the host's library (Photos, in the app).
public protocol MomentSaving: Sendable {
    /// Throws `MomentSavingError.accessDenied` when the library refuses
    /// the app; any other error fails just this file.
    func save(fileAt url: URL, kind: Media.Kind) async throws
}

public enum MomentSavingError: Error, Equatable, Sendable {
    case accessDenied
}

/// Fetches one media file into a temporary file the caller then owns.
public protocol MediaDownloading: Sendable {
    func download(_ url: URL) async throws -> URL
}

/// "Download everything": every moment guests can see, saved one by one to
/// the host's library. Hidden moments stay out (the host took them down).
/// Stream videos are skipped and counted: the server has no file for them
/// yet, only a player.
@MainActor @Observable
public final class EventDownloadModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case saving(done: Int, total: Int)
        case finished(Summary)
        case failed(Failure)
    }

    public struct Summary: Equatable, Sendable {
        public let saved: Int
        public let failed: Int
        /// Videos only playable from Stream, so not saved.
        public let skippedVideos: Int
        /// The list stopped at the server's cap, so older moments weren't included.
        public let isTruncated: Bool
        /// Stopped before the end.
        public let wasCancelled: Bool
    }

    public enum Failure: Equatable, Sendable {
        case load(HostLoadFailure)
        case gone
        /// Photos refused the app; `saved` files had already gone in.
        case photosAccessDenied(saved: Int)
    }

    public let eventID: String
    public private(set) var phase: Phase = .idle
    /// The API origin: only files there are downloaded.
    @ObservationIgnored private let origin: URL
    @ObservationIgnored private let service: any HostService
    @ObservationIgnored private let account: HostAccount
    @ObservationIgnored private let downloader: any MediaDownloading
    @ObservationIgnored private let saver: any MomentSaving

    public init(
        eventID: String, origin: URL, service: any HostService, account: HostAccount,
        downloader: any MediaDownloading, saver: any MomentSaving
    ) {
        self.eventID = eventID
        self.origin = origin
        self.service = service
        self.account = account
        self.downloader = downloader
        self.saver = saver
    }

    public var isRunning: Bool {
        switch phase {
        case .loading, .saving: true
        case .idle, .finished, .failed: false
        }
    }

    /// The moments worth saving and how many were left out (Stream videos:
    /// their links are players). Only `/media/` files on the API origin are
    /// downloaded, so a link can never send the app to another host, even
    /// one the mapper allows for playback.
    nonisolated static func plan(
        _ moments: [AdminMoment], origin: URL
    ) -> (files: [(url: URL, kind: Media.Kind)], skippedVideos: Int) {
        var files: [(url: URL, kind: Media.Kind)] = []
        var skipped = 0
        for moment in moments where !moment.isHidden {
            if let url = URL(string: moment.media.url), isOriginFile(url, origin: origin) {
                files.append((url, moment.media.kind))
            } else {
                skipped += 1
            }
        }
        return (files, skipped)
    }

    nonisolated static func isOriginFile(_ url: URL, origin: URL) -> Bool {
        url.scheme?.lowercased() == origin.scheme?.lowercased()
            && url.host()?.lowercased() == origin.host()?.lowercased()
            && url.port == origin.port
            && url.path().hasPrefix("/media/")
            && !url.pathComponents.contains("..")
    }

    /// Runs the whole download; cancelling the calling task stops after
    /// the file in progress and reports what was saved. A cancel while the
    /// list is still loading goes back to idle: nothing was saved yet.
    public func start() async {
        guard !isRunning else { return }
        account.refresh()
        guard account.currentToken() != nil else { phase = .idle; return }
        phase = .loading
        let id = eventID
        let outcome = await account.run(logCategory: "host-download", notFound: .eventNotFound) {
            try await service.adminMoments(token: $0, eventID: id)
        }
        let list: AdminMomentList
        switch outcome {
        case let .success(value): list = value
        case .notFound: phase = .failed(.gone); return
        case .signedOut, .cancelled: phase = .idle; return
        case let .failure(failure): phase = .failed(.load(failure)); return
        }

        let (files, skippedVideos) = Self.plan(list.moments, origin: origin)
        var saved = 0
        var failed = 0
        phase = .saving(done: 0, total: files.count)
        for (index, file) in files.enumerated() {
            if Task.isCancelled {
                return finish(saved: saved, failed: failed, skipped: skippedVideos, truncated: list.isTruncated, cancelled: true)
            }
            do {
                let local = try await downloader.download(file.url)
                defer { try? FileManager.default.removeItem(at: local) }
                try await saver.save(fileAt: local, kind: file.kind)
                saved += 1
            } catch MomentSavingError.accessDenied {
                phase = .failed(.photosAccessDenied(saved: saved))
                return
            } catch {
                // URLSession answers a cancel with URLError(.cancelled),
                // not CancellationError: either way the run was stopped.
                if Task.isCancelled || error is CancellationError {
                    return finish(saved: saved, failed: failed, skipped: skippedVideos, truncated: list.isTruncated, cancelled: true)
                }
                failed += 1
                Logger(subsystem: "moments", category: "host-download")
                    .notice("moment not saved: \(String(describing: type(of: error)), privacy: .public)")
            }
            phase = .saving(done: index + 1, total: files.count)
        }
        finish(saved: saved, failed: failed, skipped: skippedVideos, truncated: list.isTruncated, cancelled: false)
    }

    private func finish(saved: Int, failed: Int, skipped: Int, truncated: Bool, cancelled: Bool) {
        phase = .finished(Summary(
            saved: saved, failed: failed, skippedVideos: skipped, isTruncated: truncated, wasCancelled: cancelled
        ))
    }
}

/// The real downloader: whole files on the API origin, streamed to disk.
extension MediaFileDownloader: MediaDownloading {}
