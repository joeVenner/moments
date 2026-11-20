import Foundation
import Testing

/// The App Store reads the app's privacy manifest; it must ship in the
/// bundle and declare every required-reason API the code uses.
@Suite struct PrivacyManifestTests {
    private func manifest() throws -> [String: Any] {
        let url = try #require(Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
        let plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil)
        return try #require(plist as? [String: Any])
    }

    @Test func shipsInTheAppAndDoesNotTrack() throws {
        let manifest = try manifest()
        #expect(manifest["NSPrivacyTracking"] as? Bool == false)
        #expect((manifest["NSPrivacyTrackingDomains"] as? [String])?.isEmpty == true)
    }

    @Test func declaresTheRequiredReasonAPIsInUse() throws {
        let apis = try #require(manifest()["NSPrivacyAccessedAPITypes"] as? [[String: Any]])
        let pairs = apis.compactMap { entry -> (String, [String])? in
            guard let type = entry["NSPrivacyAccessedAPIType"] as? String,
                  let reasons = entry["NSPrivacyAccessedAPITypeReasons"] as? [String] else { return nil }
            return (type, reasons)
        }
        // Every entry well formed, each category once.
        #expect(pairs.count == apis.count)
        let reasons = Dictionary(pairs, uniquingKeysWith: { first, _ in first })
        #expect(reasons.count == pairs.count)
        // UserDefaults (onboarding, settings), file dates (staging cleanup),
        // free space (before importing media), ContinuousClock (timeouts).
        #expect(reasons == [
            "NSPrivacyAccessedAPICategoryUserDefaults": ["CA92.1"],
            "NSPrivacyAccessedAPICategoryFileTimestamp": ["C617.1"],
            "NSPrivacyAccessedAPICategoryDiskSpace": ["E174.1"],
            "NSPrivacyAccessedAPICategorySystemBootTime": ["35F9.1"],
        ])
    }

    @Test func collectedDataIsForTheAppOnlyAndNeverTracked() throws {
        let types = try #require(manifest()["NSPrivacyCollectedDataTypes"] as? [[String: Any]])
        #expect(Set(types.compactMap { $0["NSPrivacyCollectedDataType"] as? String }) == [
            "NSPrivacyCollectedDataTypePhotosorVideos",
            "NSPrivacyCollectedDataTypeOtherUserContent",
            "NSPrivacyCollectedDataTypeUserID",
        ])
        for type in types {
            #expect(type["NSPrivacyCollectedDataTypeTracking"] as? Bool == false)
            #expect(type["NSPrivacyCollectedDataTypePurposes"] as? [String] == ["NSPrivacyCollectedDataTypePurposeAppFunctionality"])
        }
    }
}
