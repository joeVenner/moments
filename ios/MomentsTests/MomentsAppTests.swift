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

    @Test func pastedTextIsCappedAt2048Characters() {
        let prefix = "https://moments-hq.com/e/party?x="
        let navigation = AppNavigation(router: AppRouter())
        #expect(navigation.handle(text: prefix + String(repeating: "a", count: 2048 - prefix.count)))
        #expect(!navigation.handle(text: prefix + String(repeating: "a", count: 2049 - prefix.count)))
    }

    @Test func aPastedLinkOpensTheEventWithItsInvite() {
        let navigation = AppNavigation(router: AppRouter())
        #expect(navigation.handle(text: "  https://moments-hq.com/e/party?invite=\(invite)\n"))
        #expect(navigation.destination == .event(EventSlug("party")!))
        #expect(navigation.takeInvite(for: EventSlug("party")!) == InviteToken(invite))
    }

    @Test(arguments: ["", "   ", "party", "moments-hq.com/e/party", "https://evil.test/e/party", "https://moments-hq.com/admin",
                      "http://moments-hq.com/e/party",
                      "https://moments-hq.com/e/" + String(repeating: "a", count: 2048)])
    func pastedTextThatIsntAnEventLinkIsRefused(_ text: String) {
        let navigation = AppNavigation(router: AppRouter())
        #expect(!navigation.handle(text: text))
        #expect(navigation.destination == nil && navigation.openCount == 0)
    }
}
