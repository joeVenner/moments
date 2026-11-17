import SwiftUI

@main
struct MomentsApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
                // Dark-only design system; Info.plist forces it for system chrome.
                .preferredColorScheme(.dark)
        }
    }
}
