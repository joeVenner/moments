import AppRouting
import DesignSystem
import FeatureGuest
import FeatureHost
import MomentsDomain
import SwiftUI

/// Shows the screen for the last opened link: the join flow for an event,
/// otherwise the first-launch pages once, then the home screen.
struct RootView: View {
    let navigation: AppNavigation
    let environment: AppEnvironment
    @State private var joinModel: JoinModel?
    @State private var myEvents: MyEventsModel
    @AppStorage(OnboardingFlow.completedKey) private var hasOnboarded = false

    init(navigation: AppNavigation, environment: AppEnvironment) {
        self.navigation = navigation
        self.environment = environment
        _myEvents = State(initialValue: MyEventsModel(service: environment.service, store: environment.credentials))
    }

    var body: some View {
        Group {
            if let joinModel {
                GuestEventView(join: joinModel, dependencies: environment.guest) {
                    // Access changed under the feed: start over with the PIN.
                    self.joinModel = makeJoinModel(slug: joinModel.slug, invite: nil)
                } onLeft: {
                    navigation.goHome()
                } onHome: {
                    navigation.goHome()
                }
                // A new model per open restarts the flow cleanly.
                .id(joinModel.id)
            } else if OnboardingFlow.shouldShow(completed: hasOnboarded, isShowingEvent: false) {
                OnboardingView { hasOnboarded = true }
            } else {
                AppShell(navigation: navigation, myEvents: myEvents, host: HomeView.Host(
                    account: environment.hostAccount, events: environment.hostEvents,
                    service: environment.hostService, mediaFetcher: environment.guest.mediaFetcher,
                    downloads: environment.hostDownloads
                ), notice: notice)
            }
        }
        // Universal links arrive here; App Clip invocations arrive as a
        // browsing-web user activity.
        .onOpenURL { navigation.handle($0) }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            if let url = activity.webpageURL { navigation.handle(url) }
        }
        // `initial`: a link handled before this view appeared (cold launch).
        .onChange(of: navigation.openCount, initial: true) { showDestination() }
        #if DEBUG
        // Simulator testing without universal links: launch with
        // MOMENTS_OPEN_URL=<event link> in the scheme or SIMCTL_CHILD_ env.
        .task {
            if let link = ProcessInfo.processInfo.environment["MOMENTS_OPEN_URL"], let url = URL(string: link) {
                navigation.handle(url)
            }
        }
        #endif
    }

    private var notice: String? {
        guard case .slideshow = navigation.destination else { return nil }
        return String(localized: "The slideshow is coming soon.")
    }

    private func showDestination() {
        // Last chance to keep a one-time guest token the keychain refused.
        if let joinModel, joinModel.hasUnsavedIdentity { joinModel.retrySaving() }
        guard case let .event(slug) = navigation.destination else { return joinModel = nil }
        // Arriving by an event link skips the pages: the guest came to join.
        hasOnboarded = true
        joinModel = makeJoinModel(slug: slug, invite: navigation.takeInvite(for: slug))
    }

    private func makeJoinModel(slug: EventSlug, invite: InviteToken?) -> JoinModel {
        JoinModel(slug: slug, invite: invite, service: environment.service, store: environment.credentials)
    }
}
