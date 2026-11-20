import DesignSystem
import FeatureHost
import MomentsDomain
import SwiftUI
import UIKit

/// "Download everything": saves every moment guests can see to Photos, one
/// by one, with progress and a way to stop. The screen stays awake while it
/// runs; leaving the sheet stops it.
struct EventDownloadView: View {
    @State private var model: EventDownloadModel
    @State private var run: Task<Void, Never>?
    /// Moments guests can see, from the event's stats (for the intro).
    let visibleMoments: Int
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    init(eventID: String, visibleMoments: Int, host: HomeView.Host) {
        self.init(
            model: EventDownloadModel(
                eventID: eventID, origin: host.downloads.origin, service: host.service, account: host.account,
                downloader: host.downloads.downloader, saver: host.downloads.saver
            ),
            visibleMoments: visibleMoments
        )
    }

    /// With a prepared model (tests).
    init(model: EventDownloadModel, visibleMoments: Int) {
        _model = State(initialValue: model)
        self.visibleMoments = visibleMoments
    }

    var body: some View {
        ScrollView { content }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(MomentsColor.background.ignoresSafeArea())
            .interactiveDismissDisabled(model.isRunning)
            .onChange(of: model.isRunning) { keepAwake() }
            // In the background the run is suspended: the screen may sleep.
            .onChange(of: scenePhase) { keepAwake() }
            .onChange(of: model.phase) {
                if let message = Self.announcement(for: model.phase) {
                    AccessibilityNotification.Announcement(message).post()
                }
            }
            .onDisappear {
                run?.cancel()
                UIApplication.shared.isIdleTimerDisabled = false
            }
    }

    var content: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text("Download everything")
                .font(MomentsFont.display(.title2))
                .foregroundStyle(MomentsColor.text)
                .accessibilityAddTraits(.isHeader)
            switch model.phase {
            case .idle:
                paragraph(Self.introLine(visibleMoments: visibleMoments))
                Button("Save to Photos", action: start)
                    .buttonStyle(.momentsPrimary)
                    .disabled(visibleMoments == 0)
                Button("Cancel") { dismiss() }
                    .buttonStyle(.momentsSecondary)
            case .loading:
                ProgressView()
                    .tint(MomentsColor.text)
                    .frame(maxWidth: .infinity)
                paragraph(String(localized: "Getting the list of moments…"))
                stopButton
            case let .saving(done, total):
                ProgressView(value: Double(done), total: Double(max(total, 1)))
                    .tint(MomentsColor.accent)
                paragraph(Self.progressLine(done: done, total: total))
                paragraph(String(localized: "Keep Moments open until it's done."))
                stopButton
            case let .finished(summary):
                ForEach(Self.summaryLines(summary), id: \.self) { paragraph($0) }
                doneButton
            case let .failed(failure):
                paragraph(Self.failureMessage(failure))
                if case .photosAccessDenied = failure,
                   let settings = URL(string: UIApplication.openSettingsURLString) {
                    Button("Open Settings") { openURL(settings) }
                        .buttonStyle(.momentsPrimary)
                }
                doneButton
            }
        }
        .padding(Spacing.lg)
    }

    private func paragraph(_ text: String) -> some View {
        Text(text)
            .font(MomentsFont.body())
            .foregroundStyle(MomentsColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var stopButton: some View {
        Button("Stop") { run?.cancel() }
            .buttonStyle(.momentsSecondary)
    }

    private var doneButton: some View {
        Button("Done") { dismiss() }
            .buttonStyle(.momentsSecondary)
    }

    private func start() {
        guard !model.isRunning else { return }
        run = Task { await model.start() }
    }

    private func keepAwake() {
        UIApplication.shared.isIdleTimerDisabled = model.isRunning && scenePhase == .active
    }

    // MARK: Words

    static func introLine(visibleMoments: Int) -> String {
        visibleMoments == 0
            ? String(localized: "There are no moments to save yet.")
            : String(localized: "Saves the \(visibleMoments) moments guests can see to your Photos, one by one. Hidden moments stay out.")
    }

    static func progressLine(done: Int, total: Int) -> String {
        String(localized: "\(done) of \(total) saved")
    }

    static func summaryLines(_ summary: EventDownloadModel.Summary) -> [String] {
        var lines = [
            summary.wasCancelled
                ? String(localized: "Stopped. \(summary.saved) moments saved to Photos.")
                : String(localized: "\(summary.saved) moments saved to Photos."),
        ]
        if summary.failed > 0 {
            lines.append(String(localized: "\(summary.failed) moments couldn't be saved. Try again later."))
        }
        if summary.skippedVideos > 0 {
            lines.append(String(localized: "\(summary.skippedVideos) videos can't be saved from the app yet."))
        }
        if summary.isTruncated {
            lines.append(String(localized: "Only the newest moments were included."))
        }
        return lines
    }

    static func failureMessage(_ failure: EventDownloadModel.Failure) -> String {
        switch failure {
        case let .photosAccessDenied(saved) where saved > 0:
            String(localized: "Moments can't add to Photos any more. \(saved) moments were saved. Allow access in Settings to save the rest.")
        case .photosAccessDenied:
            String(localized: "Moments can't add to Photos. Allow access in Settings, then try again.")
        case .gone: String(localized: "This event was deleted.")
        case .load(.offline): String(localized: "You're offline. Try again when you're connected.")
        case .load(.appTooOld): String(localized: "Update Moments to download this event.")
        case .load(.planRequired):
            String(localized: "Your hosting plan doesn't allow this right now. Resubscribe to bring everything back.")
        case .load(.failed): String(localized: "The moments couldn't be loaded. Try again later.")
        }
    }

    /// Read out when the download ends.
    static func announcement(for phase: EventDownloadModel.Phase) -> String? {
        switch phase {
        case let .finished(summary): summaryLines(summary).first
        case let .failed(failure): failureMessage(failure)
        case .idle, .loading, .saving: nil
        }
    }

    /// The manage row's line.
    static func rowLine(visibleMoments: Int) -> String {
        visibleMoments == 0
            ? String(localized: "Save every moment to Photos")
            : String(localized: "All \(visibleMoments) moments to Photos")
    }
}
