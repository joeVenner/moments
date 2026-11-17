import AppRouting
import SwiftUI

@main
struct MomentsApp: App {
    @State private var navigation = AppNavigation(router: Self.router)
    private let environment = AppEnvironment.live()

    var body: some Scene {
        WindowGroup {
            RootView(navigation: navigation, environment: environment)
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
