import Foundation
import Testing
@testable import UploadEngine

@Suite struct CellularPolicyTests {
    private let large = CellularPolicy.largeVideoBytes

    @Test func holdsOnlyLargeVideosForWiFi() {
        #expect(!CellularPolicy.allowsMobileData(contentType: "video/mp4", size: large, largeVideosOnWiFiOnly: true))
        #expect(!CellularPolicy.allowsMobileData(contentType: "VIDEO/QuickTime", size: large * 3, largeVideosOnWiFiOnly: true))
        #expect(CellularPolicy.allowsMobileData(contentType: "video/mp4", size: large - 1, largeVideosOnWiFiOnly: true))
        #expect(CellularPolicy.allowsMobileData(contentType: "image/jpeg", size: large * 3, largeVideosOnWiFiOnly: true))
    }

    @Test func turnedOffEverythingMayUseMobileData() {
        #expect(CellularPolicy.allowsMobileData(contentType: "video/mp4", size: large * 3, largeVideosOnWiFiOnly: false))
    }

    @Test func theChoiceIsOnUntilTurnedOff() throws {
        let suite = "CellularPolicyTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        #expect(CellularPolicy.largeVideosOnWiFiOnly(in: defaults))
        defaults.set(false, forKey: CellularPolicy.largeVideosOnWiFiOnlyKey)
        #expect(!CellularPolicy.largeVideosOnWiFiOnly(in: defaults))
    }

    @Test func partRequestsCarryThePolicy() throws {
        let url = try #require(URL(string: "https://example.r2.cloudflarestorage.com/part"))
        let video = QueuedUpload(
            eventSlug: "party", file: try #require(.init(relativePath: "staged/v", size: large, contentType: "video/mp4")),
            caption: nil, createdAt: Date(timeIntervalSince1970: 0)
        )
        let held = BackgroundPartUploader.partRequest(to: url, for: video, largeVideosOnWiFiOnly: true)
        #expect(held.httpMethod == "PUT")
        #expect(!held.allowsExpensiveNetworkAccess)
        #expect(BackgroundPartUploader.partRequest(to: url, for: video, largeVideosOnWiFiOnly: false).allowsExpensiveNetworkAccess)
        let photo = QueuedUpload(
            eventSlug: "party", file: try #require(.init(relativePath: "staged/p", size: large * 2, contentType: "image/jpeg")),
            caption: nil, createdAt: Date(timeIntervalSince1970: 0)
        )
        #expect(BackgroundPartUploader.partRequest(to: url, for: photo, largeVideosOnWiFiOnly: true).allowsExpensiveNetworkAccess)
    }
}
