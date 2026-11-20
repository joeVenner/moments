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
