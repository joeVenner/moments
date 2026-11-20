import FeatureGuest
import Foundation
import Testing

@Suite struct SendingAnnouncementTests {
    private final class Source {}
    private let model = Source()
    private let other = Source()

    private func snapshot(_ active: Int, failed: Int = 0, done: Int = 0, of source: Source? = nil) -> SendingAnnouncement.Snapshot {
        SendingAnnouncement.Snapshot(source: ObjectIdentifier(source ?? model), active: active, failed: failed, done: done)
    }

    @Test func startingToSendIsSaid() {
        #expect(SendingAnnouncement.change(from: snapshot(0, done: 3), to: snapshot(2, done: 3)) == .started)
    }

    /// A retry starts sending again; a relaunched Clip's first load of
    /// pending items says sending resumed too.
    @Test func retryingOrResumingIsSaid() {
        #expect(SendingAnnouncement.change(from: snapshot(0, failed: 1), to: snapshot(1)) == .started)
        #expect(SendingAnnouncement.change(from: snapshot(0), to: snapshot(4)) == .started)
    }

    @Test func moreToSendWhileSendingIsntSaidAgain() {
        #expect(SendingAnnouncement.change(from: snapshot(1), to: snapshot(3)) == nil)
        #expect(SendingAnnouncement.change(from: snapshot(3), to: snapshot(2, done: 1)) == nil)
    }

    @Test func finishingIsSaid() {
        #expect(SendingAnnouncement.change(from: snapshot(1, done: 2), to: snapshot(0, done: 3)) == .allSent)
    }

    @Test func failuresAreCountedWhenSendingStops() {
        #expect(SendingAnnouncement.change(from: snapshot(2, done: 1), to: snapshot(0, failed: 1, done: 2)) == .someFailed(1))
        // Earlier failures nobody retried still need attention.
        #expect(SendingAnnouncement.change(from: snapshot(1, failed: 2), to: snapshot(0, failed: 2, done: 1)) == .someFailed(2))
    }

    /// Leaving drops queued items; a removed upload goes away too. Neither
    /// was sent.
    @Test func itemsThatOnlyWentAwayArentSent() {
        #expect(SendingAnnouncement.change(from: snapshot(3, done: 1), to: snapshot(0, done: 1)) == nil)
    }

    /// A new event's model starts from its own counts.
    @Test func anotherModelIsntAChange() {
        #expect(SendingAnnouncement.change(from: snapshot(2), to: snapshot(0, done: 5, of: other)) == nil)
        #expect(SendingAnnouncement.change(from: snapshot(0, of: other), to: snapshot(2)) == nil)
    }

    @Test func failuresSayHowMany() {
        #expect(SendingAnnouncement.someFailed(3).message.contains("3"))
        #expect(SendingAnnouncement.started.message != SendingAnnouncement.allSent.message)
    }

    /// The app's event screen announces too, except while leaving.
    @Test func theEventScreenAnnouncesSending() throws {
        let file = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Sources/FeatureGuest/GuestEventView.swift")
        let source = try String(contentsOf: file, encoding: .utf8)
        #expect(source.contains(".onChange(of: progress?.sendingSnapshot)"))
        #expect(source.contains("guard let old, let new, (leave?.phase ?? .idle) == .idle,"))
        #expect(source.contains("AccessibilityNotification.Announcement(announcement.message).post()"))
    }
}
