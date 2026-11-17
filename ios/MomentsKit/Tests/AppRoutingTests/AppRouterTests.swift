import Foundation
import Testing
@testable import AppRouting
import MomentsDomain

private let router = AppRouter()
private let invite = String(repeating: "ab12", count: 16)

private func route(_ text: String) -> Route? { router.route(for: URL(string: text)!) }

@Suite struct AppRouterTests {
    @Test func parsesAnEventLinkWithInvite() throws {
        let parsed = try #require(route("https://moments-hq.com/e/Soiree-Lea-a1b2?invite=\(invite)&utm_source=qr"))
        guard case let .event(slug, token) = parsed else { Issue.record("not an event route"); return }
        #expect(slug.value == "soiree-lea-a1b2")
        #expect(token?.value == invite)
    }

    @Test func parsesEventAndSlideshowWithoutInvite() {
        #expect(route("https://www.moments-hq.com/e/party/") == .event(EventSlug("party")!, invite: nil))
        #expect(route("https://moments-hq.com/e/party/slideshow") == .slideshow(EventSlug("party")!))
    }

    @Test func dropsAMalformedInviteButKeepsTheEvent() {
        #expect(route("https://moments-hq.com/e/party?invite=short") == .event(EventSlug("party")!, invite: nil))
        #expect(route("https://moments-hq.com/e/party?invite=\(invite)%3Cscript%3E") == .event(EventSlug("party")!, invite: nil))
    }

    @Test(arguments: [
        "http://moments-hq.com/e/party",
        "https://evil.test/e/party",
        "https://moments-hq.com.evil.test/e/party",
        "https://evil.test@moments-hq.com/e/party",
        "https://moments-hq.com:8443/e/party",
        "https://moments-hq.com/x/party",
        "https://moments-hq.com/e/",
        "https://moments-hq.com/e/party/admin",
        "https://moments-hq.com/e/party/slideshow/x",
        "https://moments-hq.com/e//party",
        "https://moments-hq.com/e/par%2Fty",
        "https://moments-hq.com/e/party%2Fslideshow",
        "https://moments-hq.com/e/%2e%2e",
        "https://moments-hq.com./e/party",
        "https://xn--moments-hq-xyz.com/e/party",
        "https://moments-hq.com/e/party?invite=\(invite)&invite=\(invite)",
        "https://moments-hq.com/e/-party",
        "https://moments-hq.com/e/caf%C3%A9",
        "moments://e/party",
        "https://localhost/e/party",
    ])
    func rejectsForeignOrMalformedLinks(_ text: String) {
        #expect(route(text) == nil)
    }

    @Test func scannedTextIsTrimmedAndBounded() {
        #expect(router.route(forScannedText: "  https://moments-hq.com/e/party\n") == .event(EventSlug("party")!, invite: nil))
        #expect(router.route(forScannedText: "hello") == nil)
        // Valid link, but padded past the 2048-character limit with a query.
        let padded = "https://moments-hq.com/e/party?x=" + String(repeating: "a", count: 2048)
        #expect(router.route(for: URL(string: padded)!) != nil)
        #expect(router.route(forScannedText: padded) == nil)
    }

    @Test func acceptsServerSlugEdgeCasesAndUppercase() {
        #expect(route("https://moments-hq.com/e/PARTY") == .event(EventSlug("party")!, invite: nil))
        #expect(route("https://moments-hq.com/e/long-title--a1b2")?.slug.value == "long-title--a1b2")
        #expect(route("https://moments-hq.com/e/long-title-")?.slug.value == "long-title-")
    }

    @Test func inviteOnWWWAndIgnoredOnSlideshowAndFragments() {
        let withInvite = route("https://www.moments-hq.com/e/party?invite=\(invite)#top")
        #expect(withInvite == .event(EventSlug("party")!, invite: InviteToken(invite)))
        #expect(route("https://moments-hq.com/e/party/slideshow/?invite=\(invite)") == .slideshow(EventSlug("party")!))
    }

    @Test func inviteLengthBounds() {
        #expect(InviteToken(String(repeating: "a", count: 15)) == nil)
        #expect(InviteToken(String(repeating: "a", count: 16)) != nil)
        #expect(InviteToken(String(repeating: "a", count: 200)) != nil)
        #expect(InviteToken(String(repeating: "a", count: 201)) == nil)
    }

    @Test func localhostVariants() {
        let dev = AppRouter(allowsInsecureLocalhost: true)
        #expect(dev.route(for: URL(string: "http://127.0.0.1:8787/e/party")!) != nil)
        #expect(dev.route(for: URL(string: "https://localhost/e/party")!) == nil)
    }

    @Test func localhostOnlyWhenAllowed() {
        let dev = AppRouter(allowsInsecureLocalhost: true)
        #expect(dev.route(for: URL(string: "http://localhost:5173/e/party")!) == .event(EventSlug("party")!, invite: nil))
        #expect(dev.route(for: URL(string: "http://192.168.1.4:5173/e/party")!) == nil)
    }

    @Test func slugRules() {
        #expect(EventSlug("Party-2026")?.value == "party-2026")
        #expect(EventSlug("") == nil)
        #expect(EventSlug("a--b")?.value == "a--b")
        #expect(EventSlug("-a") == nil)
        #expect(EventSlug("\u{212A}elvin") == nil)
        #expect(EventSlug(String(repeating: "a", count: 81)) == nil)
    }

    @Test func inviteNeverAppearsInDescriptions() {
        let token = InviteToken(invite)!
        let routeValue = Route.event(EventSlug("party")!, invite: token)
        var dumped = ""
        dump(routeValue, to: &dumped)
        for text in [String(describing: token), String(reflecting: token), "\(routeValue)", String(reflecting: routeValue), dumped] {
            #expect(!text.contains(invite), "\(text)")
        }
    }
}
