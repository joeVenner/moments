import AppRouting
import Foundation
import Testing

/// Links open the app only for domains its entitlements claim (and whose
/// apple-app-site-association lists the app). The claims must match the
/// hosts the router accepts: a missing one sends links to Safari, an extra
/// one claims links the app would ignore.
@Suite struct AssociatedDomainsTests {
    /// The app's source folder (`ios/`): app-hosted tests run in the
    /// simulator, which reads the Mac's file system. This checks the source
    /// files, not a signed build's entitlements.
    private static let sourceRoot = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()

    private func source(_ path: String) throws -> Data {
        let url = Self.sourceRoot.appending(path: path)
        try #require(FileManager.default.fileExists(atPath: url.path(percentEncoded: false)), "\(path) isn't visible from this test host")
        return try Data(contentsOf: url)
    }

    private func domains() throws -> [String] {
        let entitlements = try #require(
            PropertyListSerialization.propertyList(from: source("Config/Moments.entitlements"), format: nil) as? [String: Any]
        )
        return try #require(entitlements["com.apple.developer.associated-domains"] as? [String])
    }

    @Test func theAppClaimsExactlyTheRoutersHostsAndTheClipsDomain() throws {
        let expected = Set(AppRouter.productionHosts.map { "applinks:\($0)" })
            // Apple asks for the App Clip's domain on the app target too, not
            // only on the Clip ("Associating your App Clip with your website").
            .union(["appclips:moments-hq.com"])
        let claimed = try domains()
        #expect(Set(claimed) == expected)
        #expect(claimed.count == expected.count)
    }

    private func keychainGroups(_ file: String) throws -> [String] {
        let entitlements = try #require(
            PropertyListSerialization.propertyList(from: source(file), format: nil) as? [String: Any]
        )
        return try #require(entitlements["keychain-access-groups"] as? [String])
    }

    @Test func onlyTheSharedKeychainGroupReachesTheClip() throws {
        let own = "$(AppIdentifierPrefix)$(MOMENTS_BUNDLE_ID_PREFIX).moments"
        // The app's own group first: items saved without a group (host
        // sessions) land there, out of the Clip's reach.
        #expect(try keychainGroups("Config/Moments.entitlements") == [own, own + ".shared"])
        #expect(try keychainGroups("Config/MomentsClip.entitlements") == [own + ".shared"])
    }

    @Test func bothAppConfigurationsSignWithTheEntitlements() throws {
        let project = try #require(String(data: source("Moments.xcodeproj/project.pbxproj"), encoding: .utf8))
        #expect(project.components(separatedBy: "CODE_SIGN_ENTITLEMENTS = Config/Moments.entitlements;").count - 1 == 2)
    }
}
