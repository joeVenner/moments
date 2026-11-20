import Testing
@testable import Moments

@Suite struct AppTabStateTests {
    @Test func startsOnEventsWithHostingUnbuilt() {
        let tabs = AppTabState()
        #expect(tabs.tab == .events && !tabs.hasOpenedHosting)
    }

    @Test func openingHostingBuildsItAndRefreshesTheAccount() {
        var tabs = AppTabState()
        #expect(tabs.select(.hosting) == .hostAccount)
        #expect(tabs.tab == .hosting && tabs.hasOpenedHosting)
    }

    @Test func goingBackToEventsReloadsThemAndKeepsHostingBuilt() {
        var tabs = AppTabState()
        _ = tabs.select(.hosting)
        #expect(tabs.select(.events) == .myEvents)
        #expect(tabs.tab == .events && tabs.hasOpenedHosting)
    }

    @Test func tappingTheShowingTabDoesNothing() {
        var tabs = AppTabState()
        #expect(tabs.select(.events) == nil)
        _ = tabs.select(.hosting)
        #expect(tabs.select(.hosting) == nil)
    }
}
