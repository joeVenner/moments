import AppRouting
import DesignSystem
import FeatureGuest
import MomentsDomain
import StoreKit
import SwiftUI
import UIKit
import UploadEngine

/// The App Clip: opened from an event's QR code or link without installing
/// the app. The guest joins the event here (the app picks the identity up
/// when installed) and shares photos while the Clip is open (App Clips
/// can't use background sessions).
@main
struct MomentsClipApp: App {
    @State private var route: Route?

    var body: some Scene {
        WindowGroup {
            ClipRootView(route: route)
                // Invoked by a QR code, App Clip Code, Safari banner or Messages.
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    route = activity.webpageURL.flatMap(Self.router.route(for:))
                }
                // Xcode's run scheme and the simulator pass the URL this way.
                .onOpenURL { url in route = Self.router.route(for: url) }
                #if DEBUG
                // `simctl launch` can't invoke a Clip with a link (the domain
                // isn't verified there): debug builds take one from the
                // environment instead.
                .task {
                    if route == nil, let link = ProcessInfo.processInfo.environment["MOMENTS_CLIP_URL"].flatMap(URL.init(string:)) {
                        route = Self.router.route(for: link)
                    }
                }
                #endif
        }
    }

    /// Same hosts and paths as the app; production links only.
    private static let router = AppRouter()
}

struct ClipRootView: View {
    let route: Route?
    @State private var isOfferingApp = false
    @State private var join: JoinModel?
    @State private var upload: UploadModel?
    /// The model the sheet shows, kept until it is really dismissed (a
    /// picker over it mustn't count), when its unshared picks are dropped.
    @State private var presentedUpload: UploadModel?
    @State private var progress: UploadProgressModel?
    @State private var isShowingProgress = false
    @Environment(\.scenePhase) private var scenePhase
    /// The Clip can't send in the background, so the screen stays on while
    /// it sends.
    @State private var screenAwake = ScreenAwakeHold { UIApplication.shared.isIdleTimerDisabled = $0 }

    private static let client = ClipClient.make()
    private static let store = ClipCredentials.store()
    /// Nil (sharing hidden) if the upload folders can't be set up.
    private static let uploads = ClipUploads.start(client: client, credentials: store)

    private struct EventLink: Equatable {
        let slug: EventSlug
        let invite: InviteToken?
    }

    private var eventLink: EventLink? {
        guard case let .event(slug, invite) = route else { return nil }
        return EventLink(slug: slug, invite: invite)
    }

    var body: some View {
        Group {
            if let join {
                if case let .joined(event, participant) = join.phase {
                    joined(as: participant.nickname, event: event, slug: join.slug)
                } else {
                    JoinView(model: join)
                }
            } else {
                message
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MomentsColor.background)
        // The whole link: the same event with another invite starts over,
        // dropping the last event's unshared picks and closing its sheets.
        .onChange(of: eventLink, initial: true) {
            presentedUpload?.discardAll()
            presentedUpload = nil
            upload = nil
            isShowingProgress = false
            join = eventLink.map { link in
                JoinModel(slug: link.slug, invite: link.invite, service: Self.client, store: Self.store)
            }
        }
        // Follows this event's uploads for the button and the overlay.
        .task(id: eventLink?.slug) {
            progress = nil
            guard let uploads = Self.uploads, let slug = eventLink?.slug else { return }
            // Any network: the Clip's uploads never wait for Wi-Fi.
            let model = UploadProgressModel(eventSlug: slug.value, source: uploads.progress, largeVideosOnWiFiOnly: { false })
            progress = model
            await model.observe()
        }
        // However the sheet closes, unshared picks and files are dropped.
        .sheet(item: $upload, onDismiss: {
            presentedUpload?.discardAll()
            presentedUpload = nil
        }) { model in
            UploadView(model: model)
        }
        .sheet(isPresented: $isShowingProgress) {
            if let progress { UploadProgressView(model: progress, showsWiFiChoice: false) }
        }
        // Back in front: what failed while suspended (as if offline) goes
        // again now rather than after the offline wait.
        // Only after the background: a passing Control Centre or banner
        // doesn't cut a real offline wait short.
        .onChange(of: scenePhase) { old, phase in
            if old == .background, phase == .active, let uploads = Self.uploads { Task { await uploads.progress.resume() } }
            updateScreenAwake()
        }
        .onChange(of: progress?.activeCount ?? 0, initial: true) { updateScreenAwake() }
        .onDisappear { screenAwake.release() }
        // The system banner that installs the full app. Not while joining:
        // it would cover the form's buttons.
        .onChange(of: shouldOfferApp, initial: true) { _, offer in isOfferingApp = offer }
        .appStoreOverlay(isPresented: $isOfferingApp) {
            SKOverlay.AppClipConfiguration(position: .bottom)
        }
    }

    private func updateScreenAwake() {
        screenAwake.update(activeCount: progress?.activeCount ?? 0, isInFront: scenePhase == .active)
    }

    private var shouldOfferApp: Bool {
        // Not over a sheet (it would cover the share button). While photos
        // are sending too: the app takes over what the Clip hasn't sent
        // (`UploadLaunch.prepare(adopting:)`) and goes on in the background.
        guard let join, upload == nil, !isShowingProgress else { return false }
        if case .joined = join.phase { return true }
        return false
    }

    private var message: some View {
        VStack(spacing: Spacing.lg) {
            Spacer()
            Text(verbatim: "Moments")
                .font(MomentsFont.display(.largeTitle))
                .foregroundStyle(MomentsColor.text)
            // No link yet, someone else's link, or a slideshow (meant for a
            // big screen in a browser).
            Text("Scan an event's QR code to open it.")
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .padding(Spacing.lg)
    }

    private func joined(as nickname: String, event: Event, slug: EventSlug) -> some View {
        VStack(spacing: Spacing.lg) {
            Spacer()
            Text("You're in, \(nickname).")
                .font(MomentsFont.display(.title))
                .foregroundStyle(MomentsColor.text)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            if !event.acceptsUploads {
                // As loaded on joining; if it closes later, the upload
                // list says so for anything still sending.
                Text("This event has stopped taking photos.")
                    .font(MomentsFont.body())
                    .foregroundStyle(MomentsColor.textMuted)
                    .multilineTextAlignment(.center)
                if let progress { uploadsButton(progress) }
            } else if let uploads = Self.uploads {
                // The banner below is the system's: the reason to install is said here.
                Group {
                    if (progress?.activeCount ?? 0) > 0 {
                        Text("Sending your photos. Keep this open, or get the app to keep sending in the background.")
                    } else {
                        Text("Keep this open until your photos are sent.")
                    }
                }
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
                .multilineTextAlignment(.center)
                shareButton(uploads, slug: slug)
                if let progress { uploadsButton(progress) }
            } else {
                Text("Get the Moments app to share your photos. You'll still be you there.")
                    .font(MomentsFont.body())
                    .foregroundStyle(MomentsColor.textMuted)
                    .multilineTextAlignment(.center)
            }
            Spacer()
        }
        .padding(Spacing.lg)
    }

    private func shareButton(_ uploads: ClipUploads.Parts, slug: EventSlug) -> some View {
        Button {
            let model = UploadModel(eventSlug: slug.value, staging: uploads.staging, submitter: uploads.submitter)
            presentedUpload = model
            upload = model
        } label: {
            Label("Share moments", systemImage: "plus")
                .font(MomentsFont.body().bold())
                .foregroundStyle(MomentsColor.onAccent)
                .padding(.horizontal, Spacing.lg)
                .frame(minHeight: 52)
                .background(MomentsColor.accent, in: Capsule())
        }
        .accessibilityHint(Text("Photos and videos from your library"))
    }

    /// Shown once something was shared, with a mark when one needs
    /// attention; VoiceOver hears the counts.
    @ViewBuilder private func uploadsButton(_ progress: UploadProgressModel) -> some View {
        if !progress.rows.isEmpty {
            Button { isShowingProgress = true } label: {
                Label {
                    Text("Your uploads")
                } icon: {
                    Image(systemName: progress.failedCount > 0 ? "exclamationmark.arrow.circlepath" : "arrow.up.circle")
                }
                .font(MomentsFont.body())
                .foregroundStyle(progress.failedCount > 0 ? MomentsColor.accent : MomentsColor.textMuted)
                .frame(minHeight: 44)
            }
            .accessibilityValue(Text(uploadsSummary(progress)))
        }
    }

    private func uploadsSummary(_ progress: UploadProgressModel) -> String {
        var parts: [String] = []
        if progress.activeCount > 0 { parts.append(String(localized: "\(progress.activeCount) in progress")) }
        if progress.failedCount > 0 { parts.append(String(localized: "\(progress.failedCount) need attention")) }
        return parts.joined(separator: ", ")
    }
}
