import AppRouting
import DesignSystem
import FeatureGuest
import MomentsDomain
import StoreKit
import SwiftUI

/// The App Clip: opened from an event's QR code or link without installing
/// the app. The guest joins the event here (the app picks the identity up
/// when installed); sharing from the Clip comes next (foreground uploads
/// only: App Clips can't use background sessions).
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

    private static let client = ClipClient.make()
    private static let store = ClipCredentials.store()

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
                if case let .joined(_, participant) = join.phase {
                    joined(as: participant.nickname)
                } else {
                    JoinView(model: join)
                }
            } else {
                message
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MomentsColor.background)
        // The whole link: the same event with another invite starts over.
        .onChange(of: eventLink, initial: true) {
            join = eventLink.map { link in
                JoinModel(slug: link.slug, invite: link.invite, service: Self.client, store: Self.store)
            }
        }
        // The system banner that installs the full app. Not while joining:
        // it would cover the form's buttons.
        .onChange(of: shouldOfferApp, initial: true) { _, offer in isOfferingApp = offer }
        .appStoreOverlay(isPresented: $isOfferingApp) {
            SKOverlay.AppClipConfiguration(position: .bottom)
        }
    }

    private var shouldOfferApp: Bool {
        guard let join else { return false }
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

    private func joined(as nickname: String) -> some View {
        VStack(spacing: Spacing.lg) {
            Spacer()
            Text("You're in, \(nickname).")
                .font(MomentsFont.display(.title))
                .foregroundStyle(MomentsColor.text)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text("Get the Moments app to share your photos. You'll still be you there.")
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .padding(Spacing.lg)
    }
}
