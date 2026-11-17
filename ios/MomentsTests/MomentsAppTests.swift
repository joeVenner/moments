import MomentsDomain
import Testing
@testable import Moments

/// Smoke tests for the app target: it builds, hosts tests, and links the
/// shared package. Feature tests live in MomentsKit.
@Suite struct MomentsAppTests {
    @Test @MainActor func rootViewBuilds() {
        _ = RootView().body
    }

    @Test func linksMomentsDomain() {
        #expect(Points.forContentType("video/mp4") == 3)
    }
}
