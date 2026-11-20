import Foundation
import Testing
@testable import UploadEngine

private let loaded = UploadLaunch.Report(loaded: QueueStore.Loaded(items: [], quarantined: 0, deferred: 0), swept: 0)
private let failed = UploadLaunch.Report(loaded: nil, swept: nil)

private final class Recorder: @unchecked Sendable {
    var attempts = 0
    var sleeps: [Duration] = []
}

@Suite struct UploadLaunchRetryTests {
    @Test func aQueueThatLoadsIsntTriedAgain() async {
        let recorder = Recorder()
        let report = await UploadLaunch.retrying(sleep: { recorder.sleeps.append($0) }) {
            recorder.attempts += 1
            return loaded
        }
        #expect(report == loaded)
        #expect(recorder.attempts == 1)
        #expect(recorder.sleeps.isEmpty)
    }

    @Test func aPassingFailureGetsAnotherTry() async {
        let recorder = Recorder()
        let report = await UploadLaunch.retrying(sleep: { recorder.sleeps.append($0) }) {
            recorder.attempts += 1
            return recorder.attempts < 3 ? failed : loaded
        }
        #expect(report == loaded)
        #expect(recorder.attempts == 3)
        #expect(recorder.sleeps == [.seconds(1), .seconds(3)])
    }

    @Test func itGivesUpAfterTheLastDelay() async {
        let recorder = Recorder()
        let report = await UploadLaunch.retrying(sleep: { recorder.sleeps.append($0) }) {
            recorder.attempts += 1
            return failed
        }
        #expect(report == failed)
        #expect(recorder.attempts == 3)
    }
}

@Suite struct UploadLaunchRetryAdoptionTests {
    /// The first attempt's adoption happened even though its load failed:
    /// the report keeps its counts.
    @Test func keepsCountsFromEveryAttempt() async {
        let attempts = AttemptLog()
        let first = UploadLaunch.Report(loaded: nil, swept: nil, adoption: .init(moved: .init(adopted: 3), dropped: 1))
        let second = UploadLaunch.Report(
            loaded: QueueStore.Loaded(items: [], quarantined: 0, deferred: 0), swept: 0, adoption: .init(moved: .init(skipped: 1))
        )
        let report = await UploadLaunch.retrying(after: [.zero], sleep: { _ in }) {
            attempts.next() == 0 ? first : second
        }
        #expect(report.adoption == .init(moved: .init(adopted: 3, skipped: 1), dropped: 1))
        #expect(report.loaded != nil)
    }
}

private final class AttemptLog: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func next() -> Int { lock.withLock { defer { count += 1 }; return count } }
}
