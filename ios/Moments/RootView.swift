import MomentsDomain
import SwiftUI

/// Placeholder until the join flow lands. Colours are the web's dark tokens
/// (src/client/index.css); the DesignSystem module replaces these literals.
struct RootView: View {
    var body: some View {
        VStack(spacing: 12) {
            Text("Moments")
                .font(.largeTitle.weight(.semibold))
                .foregroundStyle(Color(red: 0xED / 255, green: 0xED / 255, blue: 0xED / 255))
            Text("Scan an event QR code to join.")
                .font(.body)
                .foregroundStyle(Color(red: 0xA1 / 255, green: 0xA1 / 255, blue: 0xA1 / 255))
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(red: 0x1A / 255, green: 0x1A / 255, blue: 0x1A / 255))
    }
}

#Preview {
    RootView()
}
