import Foundation
import Testing

/// The App Clip ships inside the app (Moments.app/AppClips): App Store
/// Connect finds it there, with its own identity and privacy manifest.
@Suite struct AppClipEmbedTests {
    private var clip: Bundle? {
        Bundle(url: Bundle.main.bundleURL.appending(path: "AppClips/MomentsClip.app"))
    }

    @Test func theClipIsEmbeddedAsAnAppClipOfThisApp() throws {
        let clip = try #require(clip)
        let appID = try #require(Bundle.main.bundleIdentifier)
        #expect(clip.bundleIdentifier == "\(appID).Clip")
        #expect(clip.object(forInfoDictionaryKey: "NSAppClip") is [String: Any])
        // Same version as the app, as App Store Connect requires.
        for key in ["CFBundleShortVersionString", "CFBundleVersion"] {
            let appValue = try #require(Bundle.main.object(forInfoDictionaryKey: key) as? String)
            #expect(clip.object(forInfoDictionaryKey: key) as? String == appValue)
        }
    }

    @Test func theClipHasItsOwnPrivacyManifest() throws {
        let clip = try #require(clip)
        let url = try #require(clip.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
        let manifest = try #require(
            PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any]
        )
        // The Clip only reads its link today: no tracking, nothing collected.
        // Revisit with joining and uploading from the Clip.
        #expect(manifest["NSPrivacyTracking"] as? Bool == false)
        #expect((manifest["NSPrivacyCollectedDataTypes"] as? [Any])?.isEmpty == true)
    }
}
