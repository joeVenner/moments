import AppRouting
import AVFoundation
import CoreImage
import DesignSystem
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

    @Test func theFlyerIsOneA6PageNamedAfterTheEvent() throws {
        let event = Event(
            id: "e1", slug: "sara-omar", title: "Sara & Omar's wedding", type: "Wedding",
            createdAt: .now, accessMode: .private
        )
        let flyer = EventFlyer(event: event, url: try #require(URL(string: "https://moments-hq.com/e/sara-omar")))
        #expect(flyer.fileName == "sara-omar-flyer.pdf")
        #expect(flyer.isPrivate)
        let file = try flyer.writePDF()
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        #expect(file.lastPathComponent == "sara-omar-flyer.pdf")
        let pdf = try #require(CGPDFDocument(file as CFURL))
        #expect(pdf.numberOfPages == 1)
        let box = try #require(pdf.page(at: 1)).getBoxRect(.mediaBox)
        #expect(abs(box.width - EventFlyer.pageSize.width) < 1 && abs(box.height - EventFlyer.pageSize.height) < 1)
    }

    @Test(arguments: [("../../etc", "etc-flyer.pdf"), ("a/b", "ab-flyer.pdf"), ("", "flyer.pdf"), ("..", "flyer.pdf"), ("fête", "fte-flyer.pdf")])
    func theFlyerFileNameNeverNamesAPath(slug: String, expected: String) throws {
        let event = Event(id: "e1", slug: slug, title: "Party", type: "Party", createdAt: .now)
        let flyer = EventFlyer(event: event, url: try #require(URL(string: "https://moments-hq.com/e/x")))
        #expect(flyer.fileName == expected)
    }

    @Test func theModerateBadgeShowsOnlyWhenSomethingWaits() {
        #expect(HostManageRow.badgeLabel(0) == nil)
        #expect(HostManageRow.badgeLabel(-1) == nil)
        #expect(HostManageRow.badgeLabel(3) == "3 to review")
    }

    @Test func everySignInFailureHasItsOwnMessage() {
        let failures: [HostAccount.SignInFailure] = [.invalidCredentials, .locked, .unavailable, .appTooOld, .offline, .failed]
        let messages = failures.map(HostSignInView.message(for:))
        #expect(Set(messages).count == failures.count)
        #expect(HostSignInView.message(for: .locked).contains("15"))
    }

    @Test func newEventProblemsAreWordedInOrderAndMissingFieldsStaySilent() {
        let messages = HostEventFormText.messages(for: [.titleMissing, .typeMissing, .endBeforeStart, .titleTooLong])
        #expect(messages.count == 2)
        #expect(messages.first?.contains("120") == true && messages.last?.contains("before") == true)
    }

    @Test func everyCreateFailureHasItsOwnMessageAndAnUnclearOneSaysToCheck() {
        let failures: [HostSaveFailure] = [.offline, .appTooOld, .rateLimited, .refused, .failed]
        let messages = failures.map { HostNewEventView.message(for: $0, mayHaveCreated: false) }
        #expect(Set(messages).count == failures.count)
        let unclear = HostNewEventView.message(for: .offline, mayHaveCreated: true)
        #expect(unclear == HostNewEventView.message(for: .failed, mayHaveCreated: true) && !messages.contains(unclear))
        // A refusal is never ambiguous: the server said no.
        #expect(HostNewEventView.message(for: .rateLimited, mayHaveCreated: true) == messages[2])
    }

    @Test func everyEditFailureHasItsOwnMessage() {
        let failures: [HostSaveFailure] = [.offline, .appTooOld, .rateLimited, .refused, .gone, .failed]
        #expect(Set(failures.map(HostEventFormText.editMessage(for:))).count == failures.count)
    }

    @Test func dateProblemsAreWordedInOrder() {
        let messages = HostEventFormText.messages(for: Set<HostEventDatesModel.Problem>([.closeAfterDelete, .deleteInPast]))
        #expect(messages.count == 2 && messages[0].contains("passed") && messages[1].contains("before"))
    }

    @Test func pinProblemsNeverRepeatAndNeverShowThePIN() {
        let messages = HostEditPrivacyView.messages(for: [.pinRequired, .pinTooShort, .pinTooLong])
        #expect(messages.count == 2)
        #expect(messages[1].contains("6") && messages[1].contains("20"))
        #expect(HostEditPrivacyView.messages(for: []).isEmpty)
    }

    @Test func editSheetsCloseOnlyWhenSavedOrSignedOut() {
        #expect(HostSavePhase.signedOut.isDone)
        #expect(!HostSavePhase.editing.isDone && !HostSavePhase.saving.isDone && !HostSavePhase.failed(.gone).isDone)
    }

    @Test func defaultDatesStartOnTheHour() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "Europe/Paris"))
        let date = try #require(calendar.date(from: DateComponents(year: 2026, month: 11, day: 19, hour: 22, minute: 41)))
        let next = HostEventFormText.nextHour(after: date, addingDays: 1, calendar: calendar)
        #expect(calendar.dateComponents([.day, .hour, .minute], from: next) == DateComponents(day: 20, hour: 23, minute: 0))
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

    @Test func theEventPageRowsSayThePrivacyAndWhatHappensNext() {
        func event(open: Bool = true, archived: Bool = false, purge: Date? = nil, mode: Event.AccessMode = .public) -> Event {
            Event(id: "e", slug: "e", title: "Party", type: "Party", createdAt: Date(timeIntervalSince1970: 1_795_000_000),
                  uploadsCloseAt: Date(timeIntervalSince1970: 1_796_000_000), purgeAfter: purge,
                  archivedAt: archived ? Date() : nil, accessMode: mode, areUploadsOpen: open)
        }
        #expect(HostEventDetailView.privacyLine(event(mode: .private)) != HostEventDetailView.privacyLine(event(mode: .public)))
        let open = event()
        #expect(HostEventDetailView.datesLine(open) == HostEventsView.liveLine(open))
        let purge = Date(timeIntervalSince1970: 1_797_000_000)
        let closedWithPurge = HostEventDetailView.datesLine(event(open: false, purge: purge))
        let closedWithoutPurge = HostEventDetailView.datesLine(event(open: false))
        let archived = HostEventDetailView.datesLine(event(open: true, archived: true, purge: purge))
        #expect(closedWithPurge.contains(purge.formatted(date: .abbreviated, time: .omitted)))
        #expect(Set([closedWithPurge, closedWithoutPurge, archived, HostEventDetailView.datesLine(open)]).count == 4)
    }

    @Test func theEventQRCodeScansAndHasAFourModuleQuietZoneInThemeColours() throws {
        let url = URL(string: "https://moments-hq.com/e/party")!
        let image = try #require(EventQRCode.image(for: url))
        let scale = Int(EventQRCode.pixelsPerModule)
        #expect(image.width == image.height && image.width % scale == 0)
        // Symbols are 17 + 4·version modules wide; plus 4 quiet modules a side.
        let symbolModules = image.width / scale - 8
        #expect(symbolModules >= 21 && (symbolModules - 17) % 4 == 0)

        let decoded = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: nil)?
            .features(in: CIImage(cgImage: image))
            .compactMap { ($0 as? CIQRCodeFeature)?.messageString }
        #expect(decoded == [url.absoluteString])

        // Every pixel of the 4-module border is the tile colour (Palette.text).
        let pixel = try #require(rgb(of: image, x: 4 * scale - 1, y: 4 * scale - 1))
        #expect(pixel == [Palette.text.red, Palette.text.green, Palette.text.blue])
        // Just inside it starts the finder pattern, in the module colour.
        let module = try #require(rgb(of: image, x: 4 * scale, y: 4 * scale))
        #expect(module == [Palette.background.red, Palette.background.green, Palette.background.blue])
    }

    private func rgb(of image: CGImage, x: Int, y: Int) -> [UInt8]? {
        var bytes = [UInt8](repeating: 0, count: 4)
        guard let context = CGContext(
            data: &bytes, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.draw(image, in: CGRect(x: -x, y: y - image.height + 1, width: image.width, height: image.height))
        return Array(bytes.prefix(3))
    }

    @Test func theTwoWeeksFollowTheUTCDay() throws {
        let formatter = ISO8601DateFormatter()
        let lastMinute = try #require(formatter.date(from: "2026-11-19T23:59:00Z"))
        let midnight = try #require(formatter.date(from: "2026-11-20T00:00:00Z"))
        #expect(HostEventStats.lastTwoWeeks([], today: lastMinute).last?.day == "2026-11-19")
        #expect(HostEventStats.lastTwoWeeks([], today: midnight).last?.day == "2026-11-20")
        #expect(HostEventStats.lastTwoWeeks([], today: midnight).first?.day == "2026-11-07")
    }

    @Test func statsTilesFormatCountsAndStorage() {
        let analytics = EventAnalytics(
            totalMoments: 1234, hiddenMoments: 2, photos: 1200, videos: 34, storageBytes: 5_000_000,
            participants: 63, reactions: 0, activity: []
        )
        let tiles = HostEventStats.tiles(analytics, locale: Locale(identifier: "en_US"))
        #expect(tiles.count == 7)
        #expect(tiles.first?.value == "1,234")
        #expect(tiles.last?.value == "5 MB")
    }

    @Test func activityFillsTheTwoWeeksWithZeros() throws {
        let today = try #require(ISO8601DateFormatter().date(from: "2026-11-19T15:00:00Z"))
        let days = HostEventStats.lastTwoWeeks([.init(day: "2026-11-19", count: 3), .init(day: "2026-11-06", count: 1), .init(day: "2026-10-01", count: 9)], today: today)
        #expect(days.count == 14)
        #expect(days.first == .init(day: "2026-11-06", count: 1))
        #expect(days.last == .init(day: "2026-11-19", count: 3))
        #expect(days.map(\.count).reduce(0, +) == 4)
    }

    @Test func everyDetailProblemHasAMessage() {
        #expect(HostEventDetailView.message(for: .loaded) == nil)
        let phases: [HostEventDetailModel.Phase] = [.gone, .failed(.offline), .failed(.appTooOld), .failed(.failed)]
        #expect(Set(phases.compactMap(HostEventDetailView.message(for:))).count == phases.count)
    }

    @Test func moderationCountsUseSingularAndPlural() {
        #expect(HostModeration.summary(total: 0, hidden: 0) == "0 moments")
        #expect(HostModeration.summary(total: 1, hidden: 0) == "1 moment")
        #expect(HostModeration.summary(total: 2, hidden: 1) == "2 moments · 1 hidden")
        #expect(HostModeration.summary(total: 3, hidden: 2) == "3 moments · 2 hidden")
    }

    @Test func moderationLabelsSayWhoAndWhetherHidden() {
        let photo = AdminMoment(
            id: "m1", eventID: "e1", uploaderName: "Sara", createdAt: .now, status: .hidden,
            media: Media(kind: .image, url: "https://moments-hq.com/media/m1.jpg")
        )
        let video = AdminMoment(
            id: "m2", eventID: "e1", uploaderName: "Omar", createdAt: .now, status: .approved,
            media: Media(kind: .video, url: "https://moments-hq.com/media/m2.mp4")
        )
        #expect(HostModeration.label(for: photo) == "Hidden photo by Sara")
        #expect(HostModeration.label(for: video) == "Video by Omar")
    }

    @Test func moderationTabsAndEmptyLinesNameTheirFilter() {
        #expect(HostModeration.tabTitle(for: .all, count: 128) == "All 128")
        #expect(HostModeration.tabTitle(for: .reported, count: 3) == "Reported 3")
        #expect(HostModeration.tabTitle(for: .hidden, count: 0) == "Hidden 0")
        let filters = HostModerationModel.Filter.allCases
        #expect(Set(filters.map { HostModeration.emptyMessage(for: $0) }).count == filters.count)
    }

    @Test func everyModerationProblemHasItsOwnMessage() {
        #expect(HostModeration.message(for: HostModerationModel.Phase.loaded) == nil)
        let phases: [HostModerationModel.Phase] = [.gone, .failed(.offline), .failed(.appTooOld), .failed(.failed)]
        #expect(Set(phases.compactMap { HostModeration.message(for: $0) }).count == phases.count)
        let failures: [HostModerationModel.ActionFailure] = [.offline, .appTooOld, .mediaKept, .failed]
        #expect(Set(failures.map { HostModeration.message(for: $0) }).count == failures.count)
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
