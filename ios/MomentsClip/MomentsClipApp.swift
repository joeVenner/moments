import AppRouting
import DesignSystem
import StoreKit
import SwiftUI

/// The App Clip: opened from an event's QR code or link without installing
/// the app. For now it shows which event the link is for and offers the full
/// app; joining and sharing from the Clip come next (foreground uploads only:
/// App Clips can't use background sessions).
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
        }
    }

    /// Same hosts and paths as the app; production links only.
    private static let router = AppRouter()
}

struct ClipRootView: View {
    let route: Route?
    @State private var isOfferingApp = false

    private var eventSlug: String? {
        guard case let .event(slug, _) = route else { return nil }
        return slug.value
    }

    var body: some View {
        VStack(spacing: Spacing.lg) {
            Spacer()
            Text(verbatim: "Moments")
                .font(MomentsFont.display(.largeTitle))
                .foregroundStyle(MomentsColor.text)
            if let slug = eventSlug {
                Text(verbatim: slug)
                    .font(MomentsFont.body())
                    .foregroundStyle(MomentsColor.textMuted)
                Text("Get the Moments app to join the event and share your photos.")
                    .font(MomentsFont.body())
                    .foregroundStyle(MomentsColor.textMuted)
                    .multilineTextAlignment(.center)
            } else {
                // No link yet, someone else's link, or a slideshow (meant
                // for a big screen in a browser).
                Text("Scan an event's QR code to open it.")
                    .font(MomentsFont.body())
                    .foregroundStyle(MomentsColor.textMuted)
                    .multilineTextAlignment(.center)
            }
            Spacer()
        }
        .padding(Spacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MomentsColor.background)
        // The system banner that installs the full app, once there is an
        // event to join with it.
        .onChange(of: eventSlug, initial: true) { _, slug in
            if slug != nil { isOfferingApp = true }
        }
        .appStoreOverlay(isPresented: $isOfferingApp) {
            SKOverlay.AppClipConfiguration(position: .bottom)
        }
    }
}
