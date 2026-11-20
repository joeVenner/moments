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

    private func entitlements(_ file: String) throws -> [String: Any] {
        try #require(PropertyListSerialization.propertyList(from: source(file), format: nil) as? [String: Any])
    }

    @Test func theAppKeepsItsKeychainGroupAndSharesOnlyAnAppGroupWithTheClip() throws {
        let app = try entitlements("Config/Moments.entitlements")
        let clip = try entitlements("Config/MomentsClip.entitlements")
        // One keychain group, the app's: items saved without a group (host
        // sessions) land there. An App Clip can't hold keychain groups at all
        // (the system refuses to install it).
        #expect(app["keychain-access-groups"] as? [String] == ["$(AppIdentifierPrefix)$(MOMENTS_BUNDLE_ID_PREFIX).moments"])
        #expect(clip["keychain-access-groups"] == nil)
        // The handover container, the same group on both, named in the app's
        // Info.plist for the store.
        let group = "group.$(MOMENTS_BUNDLE_ID_PREFIX).moments"
        #expect(app["com.apple.security.application-groups"] as? [String] == [group])
        #expect(clip["com.apple.security.application-groups"] as? [String] == [group])
        let info = try #require(PropertyListSerialization.propertyList(from: source("Config/Moments-Info.plist"), format: nil) as? [String: Any])
        #expect(info["MomentsAppGroup"] as? String == group)
    }

    @Test func bothAppConfigurationsSignWithTheEntitlements() throws {
        let project = try #require(String(data: source("Moments.xcodeproj/project.pbxproj"), encoding: .utf8))
        #expect(project.components(separatedBy: "CODE_SIGN_ENTITLEMENTS = Config/Moments.entitlements;").count - 1 == 2)
    }
}
