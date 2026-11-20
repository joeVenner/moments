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

    private func manifest(_ bundle: Bundle) throws -> [String: Any] {
        let url = try #require(bundle.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
        return try #require(
            PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any]
        )
    }

    private func values(_ manifest: [String: Any], _ list: String, _ key: String) -> Set<String> {
        Set((manifest[list] as? [[String: Any]] ?? []).compactMap { $0[key] as? String })
    }

    @Test func theClipHasItsOwnPrivacyManifest() throws {
        let clip = try manifest(try #require(clip))
        let app = try manifest(.main)
        #expect(clip["NSPrivacyTracking"] as? Bool == false)
        // Joining sends a nickname and keeps a guest identity; photos only
        // once the Clip uploads.
        #expect(values(clip, "NSPrivacyCollectedDataTypes", "NSPrivacyCollectedDataType") == [
            "NSPrivacyCollectedDataTypeUserID", "NSPrivacyCollectedDataTypeOtherUserContent",
        ])
        // The Clip links the app's guest code, so it uses the same
        // required-reason APIs.
        let apiTypes = "NSPrivacyAccessedAPITypes", apiType = "NSPrivacyAccessedAPIType"
        #expect(!values(app, apiTypes, apiType).isEmpty)
        #expect(values(clip, apiTypes, apiType) == values(app, apiTypes, apiType))
    }

    @Test func theClipHandsOverInTheAppsGroup() throws {
        let clip = try #require(clip)
        let group = try #require(Bundle.main.object(forInfoDictionaryKey: "MomentsAppGroup") as? String)
        #expect(clip.object(forInfoDictionaryKey: "MomentsAppGroup") as? String == group)
        #expect(clip.object(forInfoDictionaryKey: "MomentsKeychainGroup") == nil)
    }

    /// Security audit: only `ClipCredentials` builds the handover store, and
    /// always behind the stamping store; nothing in the Clip touches the
    /// keychain or host sessions.
    @Test func onlyClipCredentialsBuildsTheHandoverStore() throws {
        let folder = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "MomentsClip")
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        #expect(files.count >= 3)
        for file in files {
            let source = try String(contentsOf: file, encoding: .utf8)
            let name = file.lastPathComponent
            #expect(!source.contains("Keychain"), "\(name)")
            #expect(!source.contains("HostSession"), "\(name)")
            let builds = ["FileEventCredentialStore", "ClipSessionStore(", "HandoverStampingStore("]
                .map { source.contains($0) }
            if name == "ClipCredentials.swift" {
                #expect(builds == [true, true, true])
                // The file store is only ever reached through the stamping one.
                #expect(source.contains(".map { HandoverStampingStore($0) }"))
            } else {
                #expect(builds == [false, false, false], "\(name)")
            }
        }
    }
}
