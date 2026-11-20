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
        // Joining sends a nickname and keeps a guest identity, and the Clip
        // shares photos: what the app collects.
        #expect(values(clip, "NSPrivacyCollectedDataTypes", "NSPrivacyCollectedDataType") == [
            "NSPrivacyCollectedDataTypeUserID", "NSPrivacyCollectedDataTypeOtherUserContent",
            "NSPrivacyCollectedDataTypePhotosorVideos",
        ])
        // It links the app's guest code, so it uses the same required-reason
        // APIs; with the same data, the two manifests are the same.
        let apiTypes = "NSPrivacyAccessedAPITypes", apiType = "NSPrivacyAccessedAPIType"
        #expect(!values(app, apiTypes, apiType).isEmpty)
        #expect(NSDictionary(dictionary: clip).isEqual(to: app))
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

    /// The Clip's uploads live in the App Group, where the app adopts them
    /// when it replaces the Clip; nothing in the Clip uses the app's own
    /// queue folders.
    @Test func theClipQueuesUploadsInTheAppGroup() throws {
        let folder = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "MomentsClip")
        let uploads = try String(contentsOf: folder.appending(path: "ClipUploads.swift"), encoding: .utf8)
        #expect(uploads.contains("UploadFolders.clip(appGroup: appGroup)"))
        #expect(uploads.contains("appGroup: String? = ClipCredentials.appGroup"))
        // It clears its own finished and stale items at launch.
        #expect(uploads.contains("pruningAfter: CredentialHandoff.handoffWindow"))
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        for file in files {
            let source = try String(contentsOf: file, encoding: .utf8)
            #expect(!source.contains(".appDefault("), "\(file.lastPathComponent)")
        }
    }

    /// The app takes over what the Clip hasn't sent, so the install offer
    /// may show while photos are sending.
    @Test func theClipOffersTheAppWhileSending() throws {
        let file = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "MomentsClip/MomentsClipApp.swift")
        let source = try String(contentsOf: file, encoding: .utf8)
        let offer = try #require(source.range(of: "private var shouldOfferApp: Bool {"))
        let gate = source[offer.upperBound...].prefix(600)
        #expect(gate.contains("guard let join, upload == nil, !isShowingProgress, !isConfirmingLeave, leave?.phase != .leaving else { return false }"))
        #expect(!gate.contains("activeCount"))
    }

    /// Guests can leave and delete what they shared from the Clip too (App
    /// Review: user-generated content must be deletable where it's made).
    /// Its queued uploads for the event are dropped first, as in the app.
    @Test func theClipLetsAGuestLeave() throws {
        let folder = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "MomentsClip")
        let app = try String(contentsOf: folder.appending(path: "MomentsClipApp.swift"), encoding: .utf8)
        #expect(app.contains("LeaveModel(slug: link.slug, service: Self.client, store: Self.store, uploads: Self.uploads?.leaving)"))
        #expect(app.contains(".overlay(alignment: .topTrailing) { eventMenu() }"))
        // The same link again doesn't change the route: "Join again" starts over.
        #expect(app.contains("Button(\"Join again\") { startOver() }"))
        let uploads = try String(contentsOf: folder.appending(path: "ClipUploads.swift"), encoding: .utf8)
        #expect(uploads.contains("await queue.beginLeaving(eventSlug: slug)"))
        #expect(uploads.contains("await queue.endLeaving(eventSlug: slug)"))
    }

    /// The app takes the Clip's queue over only once the Clip's guests are
    /// imported (otherwise every Clip upload would look like a stranger's),
    /// and keeps strangers for the handover window.
    @Test func theAppTakesOverTheClipsQueueOnlyAfterItsGuests() throws {
        let file = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Moments/AppEnvironment.swift")
        let source = try String(contentsOf: file, encoding: .utf8)
        let preparation = try #require(source.range(of: "credentialPreparation = RetryUntilDone"))
        let ready = try #require(source.range(of: "let credentialsReady = credentialsArePrepared(credentialPreparation)"))
        #expect(preparation.upperBound < ready.lowerBound)
        #expect(source.contains("adoptingClipQueue: credentialsReady"))
        #expect(source.contains("let clipQueue = adoptingClipQueue"))
        #expect(source.contains("flatMap(UploadFolders.existing(at:))"))
        #expect(source.contains("adopting: clipQueue)"))
        #expect(source.contains("strangersKeptFor: CredentialHandoff.handoffWindow"))
    }
}
