import AppRouting
import CredentialStore
import OSLog
import SwiftUI

@main
struct MomentsApp: App {
    @State private var navigation = AppNavigation(router: Self.router)
    private let credentials: any EventCredentialStore = KeychainEventCredentialStore()

    init() {
        do {
            try CredentialLifecycle.resetIfFreshInstall(credentials)
        } catch {
            // Status only; never the item contents.
            Logger(subsystem: "moments", category: "credentials").error("fresh-install reset failed: \(String(describing: error), privacy: .public)")
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView(navigation: navigation)
                // Dark-only design system; Info.plist forces it for system chrome.
                .preferredColorScheme(.dark)
        }
    }

    /// Debug builds also accept links to a local `npm run dev`.
    private static let router: AppRouter = {
        #if DEBUG
        AppRouter(allowsInsecureLocalhost: true)
        #else
        AppRouter()
        #endif
    }()
}
