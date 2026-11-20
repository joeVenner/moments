import Testing
@testable import FeatureGuest

@MainActor @Suite struct ScreenAwakeHoldTests {
    private final class Screen {
        var calls: [Bool] = []
        var isAwake: Bool { calls.last ?? false }
    }

    @Test func staysOnOnlyWhileSendingInFront() {
        let screen = Screen()
        let hold = ScreenAwakeHold { screen.calls.append($0) }
        hold.update(activeCount: 0, isInFront: true)
        #expect(!screen.isAwake)
        hold.update(activeCount: 2, isInFront: true)
        #expect(screen.isAwake)
        hold.update(activeCount: 2, isInFront: false)
        #expect(!screen.isAwake)
        hold.update(activeCount: 1, isInFront: true)
        #expect(screen.isAwake)
        hold.update(activeCount: 0, isInFront: true)
        #expect(!screen.isAwake)
    }

    @Test func tellsTheSystemOnlyWhenTheAnswerChanges() {
        let screen = Screen()
        let hold = ScreenAwakeHold { screen.calls.append($0) }
        hold.update(activeCount: 1, isInFront: true)
        hold.update(activeCount: 3, isInFront: true)
        hold.update(activeCount: 0, isInFront: true)
        hold.update(activeCount: 0, isInFront: false)
        #expect(screen.calls == [true, false])
    }

    @Test func releaseAlwaysLetsTheScreenSleep() {
        let screen = Screen()
        let hold = ScreenAwakeHold { screen.calls.append($0) }
        hold.update(activeCount: 1, isInFront: true)
        hold.release()
        #expect(screen.calls == [true, false])
        hold.release()
        #expect(screen.calls == [true, false])
    }
}
