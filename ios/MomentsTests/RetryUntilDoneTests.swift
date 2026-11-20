import Foundation
import Testing
@testable import Moments

@Suite @MainActor struct RetryUntilDoneTests {
    private let trigger = Notification.Name("moments.tests.retry")

    @Test func retriesOnEachTriggerUntilItWorksThenStops() {
        let center = NotificationCenter()
        var attempts = 0
        let retry = RetryUntilDone(on: trigger, center: center) {
            attempts += 1
            return attempts == 3
        }
        #expect(attempts == 1 && retry.isWaiting)
        center.post(name: trigger, object: nil)
        #expect(attempts == 2 && retry.isWaiting)
        center.post(name: trigger, object: nil)
        #expect(attempts == 3 && !retry.isWaiting)
        center.post(name: trigger, object: nil)
        #expect(attempts == 3)
    }

    @Test func doneAtOnceNeverListens() {
        let center = NotificationCenter()
        var attempts = 0
        let retry = RetryUntilDone(on: trigger, center: center) { attempts += 1; return true }
        center.post(name: trigger, object: nil)
        #expect(attempts == 1 && !retry.isWaiting)
    }
}
