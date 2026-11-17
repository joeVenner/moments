import AppRouting
import Foundation
import MomentsDomain
import Testing
@testable import Moments

private let invite = String(repeating: "ab12", count: 16)

/// Smoke tests for the app target plus the navigation model.
@Suite @MainActor struct MomentsAppTests {
    @Test func rootViewBuilds() {
        _ = RootView(navigation: AppNavigation(router: AppRouter()), environment: .inMemory()).body
    }

    @Test func reactorIDsAreStablePerInstallAndDifferPerEvent() throws {
        let suite = "moments.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let secret = AppEnvironment.reactorSecret(defaults)
        #expect(secret.count == 32)
        #expect(AppEnvironment.reactorSecret(defaults) == secret)
        let ids = AppEnvironment.reactorIDs(secret: secret)
        #expect(ids("e1") == ids("e1"))
        #expect(ids("e1") != ids("e2"))
        #expect(ids("e1").wholeMatch(of: /[0-9a-f]{32}/) != nil)
        #expect(AppEnvironment.reactorIDs(secret: Data(count: 32))("e1") != ids("e1"))
    }

    @Test func linksMomentsDomain() {
        #expect(Points.forContentType("video/mp4") == 3)
    }

    @Test func linkOpensTheEventAndHandsTheInviteOutOnce() {
        let navigation = AppNavigation(router: AppRouter())
        #expect(navigation.handle(URL(string: "https://moments-hq.com/e/party?invite=\(invite)")!))
        let party = EventSlug("party")!
        #expect(navigation.destination == .event(party))
        #expect(navigation.takeInvite(for: EventSlug("other")!) == nil)
        #expect(navigation.takeInvite(for: party)?.value == invite)
        #expect(navigation.takeInvite(for: party) == nil)
    }

    @Test func duplicateDeliveryDoesNotReArmTheInvite() {
        var clock = ContinuousClock.now
        let navigation = AppNavigation(router: AppRouter(), now: { clock })
        let link = URL(string: "https://moments-hq.com/e/party?invite=\(invite)")!
        navigation.handle(link)
        #expect(navigation.takeInvite(for: EventSlug("party")!) != nil)
        navigation.handle(link)
        #expect(navigation.takeInvite(for: EventSlug("party")!) == nil)
        #expect(navigation.openCount == 1)
        clock = clock.advanced(by: .seconds(5))
        navigation.handle(link)
        #expect(navigation.openCount == 2)
    }

    @Test func foreignLinksAreIgnoredAndRepeatsStillCount() {
        var clock = ContinuousClock.now
        let navigation = AppNavigation(router: AppRouter(), now: { clock })
        let link = URL(string: "https://moments-hq.com/e/party/slideshow")!
        navigation.handle(link)
        #expect(!navigation.handle(URL(string: "https://evil.test/e/x")!))
        #expect(navigation.destination == .slideshow(EventSlug("party")!))
        clock = clock.advanced(by: .seconds(5))
        navigation.handle(link)
        #expect(navigation.openCount == 2)
    }

    @Test func aLaterLinkWithoutInviteDropsThePendingOne() {
        let navigation = AppNavigation(router: AppRouter())
        navigation.handle(URL(string: "https://moments-hq.com/e/party?invite=\(invite)")!)
        navigation.handle(URL(string: "https://moments-hq.com/e/party")!)
        #expect(navigation.takeInvite(for: EventSlug("party")!) == nil)
    }
}
