import FeatureHost
import MomentsDomain
import Photos
import Testing
@testable import Moments

@Suite struct EventDownloadViewTests {
    private func summary(
        saved: Int = 3, failed: Int = 0, skipped: Int = 0, truncated: Bool = false, cancelled: Bool = false
    ) -> EventDownloadModel.Summary {
        EventDownloadModel.Summary(
            saved: saved, failed: failed, skippedVideos: skipped, isTruncated: truncated, wasCancelled: cancelled
        )
    }

    @Test func aCleanRunSaysOnlyWhatWasSaved() {
        #expect(EventDownloadView.summaryLines(summary()) == ["3 moments saved to Photos."])
        #expect(EventDownloadView.summaryLines(summary(saved: 1)) == ["1 moment saved to Photos."])
    }

    @Test func everyGapIsExplained() {
        let lines = EventDownloadView.summaryLines(summary(failed: 2, skipped: 1, truncated: true, cancelled: true))
        #expect(lines == [
            "Stopped. 3 moments saved to Photos.",
            "2 moments couldn't be saved. Try again later.",
            "1 video can't be saved from the app yet.",
            "Only the newest moments were included.",
        ])
    }

    @Test func eachGapLineAppearsOnlyForItsOwnCount() {
        #expect(EventDownloadView.summaryLines(summary(skipped: 2)) == [
            "3 moments saved to Photos.", "2 videos can't be saved from the app yet.",
        ])
        #expect(EventDownloadView.summaryLines(summary(failed: 1)) == [
            "3 moments saved to Photos.", "1 moment couldn't be saved. Try again later.",
        ])
    }

    @Test func refusedPhotosAccessPointsToSettingsAndKeepsTheCount() {
        #expect(EventDownloadView.failureMessage(.photosAccessDenied(saved: 0)).contains("Settings"))
        let later = EventDownloadView.failureMessage(.photosAccessDenied(saved: 4))
        #expect(later.contains("4 moments were saved"))
        #expect(later.contains("Settings"))
    }

    @Test func theRowCountsOnlyMomentsGuestsSee() {
        let analytics = EventAnalytics(
            totalMoments: 10, hiddenMoments: 3, photos: 8, videos: 2, storageBytes: 0, participants: 4, reactions: 0, activity: []
        )
        #expect(HostEventDetailView.visibleMoments(analytics) == 7)
        let odd = EventAnalytics(
            totalMoments: 1, hiddenMoments: 2, photos: 1, videos: 0, storageBytes: 0, participants: 1, reactions: 0, activity: []
        )
        #expect(HostEventDetailView.visibleMoments(odd) == 0)
        #expect(EventDownloadView.rowLine(visibleMoments: 7) == "All 7 moments to Photos")
        #expect(EventDownloadView.rowLine(visibleMoments: 0) == "Save every moment to Photos")
    }

    @Test(arguments: [
        (PHAuthorizationStatus.authorized, true), (.limited, true), (.denied, false), (.restricted, false), (.notDetermined, false),
    ])
    func onlyGrantedAccessAddsToPhotos(status: PHAuthorizationStatus, canAdd: Bool) {
        #expect(PhotoLibrarySaver.canAdd(status) == canAdd)
    }
}
