import AppRouting
import AVFoundation
import FeatureHost
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

    @Test func onboardingAdvancesPageByPageThenFinishes() {
        var flow = OnboardingFlow(pageCount: 3)
        #expect(flow.page == 0 && !flow.isLastPage)
        let first = flow.advance()
        #expect(first && flow.page == 1)
        let second = flow.advance()
        #expect(second && flow.isLastPage)
        let past = flow.advance()
        #expect(!past)
        #expect(flow.page == 2)
    }

    @Test func onboardingSwipesStayWithinThePages() {
        var flow = OnboardingFlow(pageCount: 3)
        flow.show(7)
        #expect(flow.page == 2)
        flow.show(-1)
        #expect(flow.page == 0)
    }

    @Test func onboardingShowsOnceAndNeverOverAnEvent() {
        #expect(OnboardingFlow.shouldShow(completed: false, isShowingEvent: false))
        #expect(!OnboardingFlow.shouldShow(completed: true, isShowingEvent: false))
        #expect(!OnboardingFlow.shouldShow(completed: false, isShowingEvent: true))
        // Persisted: renaming it would show the pages again to everyone.
        #expect(OnboardingFlow.completedKey == "moments.onboarding.completed")
    }

    @Test func aSinglePageFlowStartsOnItsLastPage() {
        var flow = OnboardingFlow(pageCount: 1)
        #expect(flow.isLastPage)
        flow.show(3)
        #expect(flow.page == 0)
    }

    @Test func pickingAJoinedEventOpensItWithoutAnInvite() {
        let navigation = AppNavigation(router: AppRouter())
        navigation.handle(URL(string: "https://moments-hq.com/e/party?invite=\(invite)")!)
        navigation.open(EventSlug("party")!)
        #expect(navigation.destination == .event(EventSlug("party")!))
        #expect(navigation.takeInvite(for: EventSlug("party")!) == nil)
        #expect(navigation.openCount == 2)
    }

    @Test func goingHomeClearsTheEventAndALinkReopensIt() {
        let navigation = AppNavigation(router: AppRouter())
        let link = URL(string: "https://moments-hq.com/e/party")!
        navigation.handle(link)
        navigation.goHome()
        #expect(navigation.destination == nil && navigation.openCount == 2)
        // The same link right away is a new open, not a duplicate delivery.
        navigation.handle(link)
        #expect(navigation.destination == .event(EventSlug("party")!) && navigation.openCount == 3)
    }

    @Test func aRejectedCodeIsTriedOnceAndANewOneStillCounts() {
        var filter = ScanFilter()
        #expect(filter.shouldTry("https://evil.test/e/party"))
        filter.rejected("https://evil.test/e/party")
        #expect(!filter.shouldTry("https://evil.test/e/party"))
        #expect(filter.shouldTry("https://moments-hq.com/e/party"))
        #expect(!filter.shouldTry(""))
        // Two refused codes in view are each reported once, not alternately.
        filter.rejected("WIFI:S:guest;;")
        #expect(!filter.shouldTry("https://evil.test/e/party") && !filter.shouldTry("WIFI:S:guest;;"))
    }

    @Test func aScannedEventLinkOpensTheEvent() {
        let navigation = AppNavigation(router: AppRouter())
        #expect(navigation.handle(text: "https://moments-hq.com/e/party?invite=\(invite)"))
        #expect(navigation.destination == .event(EventSlug("party")!))
        #expect(!navigation.handle(text: "WIFI:S:guest;T:WPA;P:secret;;"))
    }

    @Test func everySignInFailureHasItsOwnMessage() {
        let failures: [HostAccount.SignInFailure] = [.invalidCredentials, .locked, .unavailable, .appTooOld, .offline, .failed]
        let messages = failures.map(HostSignInView.message(for:))
        #expect(Set(messages).count == failures.count)
        #expect(HostSignInView.message(for: .locked).contains("15"))
    }

    @Test func hostEventDatesSayWhenArchivedOrClosed() {
        func event(open: Bool, archived: Bool) -> Event {
            Event(id: "e", slug: "e", title: "Party", type: "Party", mainCharacters: nil, description: nil, coverImageURL: nil,
                  createdAt: Date(timeIntervalSince1970: 1_795_000_000), startsAt: nil, expiresAt: nil, uploadsCloseAt: nil,
                  purgeAfter: nil, archivedAt: archived ? Date() : nil, accessMode: .public, areUploadsOpen: open)
        }
        let plain = HostEventsView.dateLine(event(open: true, archived: false))
        #expect(!plain.contains("·"))
        #expect(HostEventsView.dateLine(event(open: false, archived: false)).hasPrefix(plain + " · "))
        #expect(HostEventsView.dateLine(event(open: false, archived: true)) != HostEventsView.dateLine(event(open: false, archived: false)))
    }

    @Test func theSimulatorHasNoScanner() {
        #if targetEnvironment(simulator)
        #expect(CameraAccess.current == .unsupported)
        #endif
    }

    @Test func afterOpeningAnEventTheScannerTriesNothingElse() {
        var filter = ScanFilter()
        filter.accepted()
        #expect(!filter.shouldTry("https://moments-hq.com/e/party"))
        #expect(!filter.shouldTry("https://moments-hq.com/e/other"))
    }

    @Test(arguments: [
        (true, AVAuthorizationStatus.authorized, true, CameraAccess.granted),
        (true, .authorized, false, .denied),
        (true, .notDetermined, false, .notDetermined),
        (true, .denied, false, .denied),
        (true, .restricted, false, .denied),
        (false, .authorized, true, .unsupported),
    ])
    func cameraAccessFollowsPermissionAndAvailability(
        _ isSupported: Bool, _ status: AVAuthorizationStatus, _ isAvailable: Bool, _ expected: CameraAccess
    ) {
        #expect(CameraAccess.from(isSupported: isSupported, status: status, isAvailable: isAvailable) == expected)
    }
}
