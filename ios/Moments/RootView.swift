import DesignSystem
import SwiftUI

/// Placeholder until the join flow lands.
struct RootView: View {
    var body: some View {
        VStack(spacing: Spacing.sm) {
            Text("Moments")
                .font(MomentsFont.display())
                .foregroundStyle(MomentsColor.text)
            Text("Scan an event QR code to join.")
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
        }
        .padding(Spacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MomentsColor.background)
    }
}

#Preview {
    RootView()
}
