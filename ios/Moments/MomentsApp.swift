import AppRouting
import DesignSystem
import SwiftUI
import UIKit

/// Routes the system's background-session handler to the upload queue.
/// A handler that arrives before uploads are set up waits here instead of
/// being released early (which would let iOS suspend the app with the
/// session's events unhandled).
@MainActor
enum BackgroundUploadEvents {
    typealias Handler = @MainActor @Sendable (_ systemCompletion: @escaping @MainActor @Sendable () -> Void) -> Void

    private static var handler: Handler?
    private static var waiting: [@MainActor @Sendable () -> Void] = []

    /// Called once when uploads are set up; releases any handler waiting.
    static func connect(_ newHandler: @escaping Handler) {
        handler = newHandler
        let pending = waiting
        waiting = []
        for completion in pending { newHandler(completion) }
    }

    static func deliver(_ completion: @escaping @MainActor @Sendable () -> Void) {
        if let handler { handler(completion) } else { waiting.append(completion) }
    }
}

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    /// The system relaunched (or woke) the app because the upload session
    /// has news; `completionHandler` must run once its events are handled.
    func application(
        _ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping @Sendable () -> Void
    ) {
        guard identifier == AppEnvironment.uploadSessionIdentifier else {
            completionHandler()
            return
        }
        BackgroundUploadEvents.deliver { completionHandler() }
    }
}

@main
struct MomentsApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var navigation = AppNavigation(router: Self.router)
    private let environment = AppEnvironment.live()

    var body: some Scene {
        WindowGroup {
            RootView(navigation: navigation, environment: environment)
                // Dark-only design system; Info.plist forces it for system chrome.
                .preferredColorScheme(.dark)
                .momentsButtonDefaults()
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
