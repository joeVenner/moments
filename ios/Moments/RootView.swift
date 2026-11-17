import AppRouting
import DesignSystem
import SwiftUI

/// Placeholder until the join flow lands: shows which event a link opened.
struct RootView: View {
    let navigation: AppNavigation

    var body: some View {
        VStack(spacing: Spacing.sm) {
            Text("Moments")
                .font(MomentsFont.display())
                .foregroundStyle(MomentsColor.text)
            Text(subtitle)
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
                .multilineTextAlignment(.center)
        }
        .padding(Spacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MomentsColor.background)
        // Universal links arrive here; App Clip invocations arrive as a
        // browsing-web user activity.
        .onOpenURL { navigation.handle($0) }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            if let url = activity.webpageURL { navigation.handle(url) }
        }
    }

    private var subtitle: String {
        switch navigation.destination {
        case nil: String(localized: "Scan an event QR code to join.")
        case let .event(slug), let .slideshow(slug): String(localized: "Opening \(slug.value)…")
        }
    }
}

#Preview {
    RootView(navigation: AppNavigation(router: AppRouter()))
}
