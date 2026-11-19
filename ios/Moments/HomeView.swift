import DesignSystem
import SwiftUI

/// The first screen: opens an event from its link. Universal links and the
/// App Clip open events directly; this covers a link that arrived some other
/// way (a message, a copied URL) and the simulator, which has no camera.
struct HomeView: View {
    let navigation: AppNavigation
    /// Shown above the link field, e.g. after a slideshow link.
    let notice: String?

    @State private var link = ""
    @State private var isRejected = false
    @FocusState private var isLinkFocused: Bool

    var body: some View {
        // Scrolls only when needed: large text sizes with the keyboard up.
        ScrollView {
            VStack(spacing: Spacing.md) {
                Text("Moments")
                    .font(MomentsFont.display())
                    .foregroundStyle(MomentsColor.text)
                Text(notice ?? String(localized: "Scan the event's QR code with your camera, or paste its link here."))
                    .font(MomentsFont.body())
                    .foregroundStyle(MomentsColor.textMuted)
                    .multilineTextAlignment(.center)
                TextField(text: $link, prompt: Text("Event link").foregroundStyle(MomentsColor.textMuted)) { Text("Event link") }
                    .linkInput()
                    .submitLabel(.go)
                    .focused($isLinkFocused)
                    .onSubmit(open)
                    .onChange(of: link) { isRejected = false }
                    .momentsField()
                if isRejected {
                    Text("That isn't a Moments event link.")
                        .font(MomentsFont.caption())
                        .foregroundStyle(MomentsColor.accent)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Button("Open event", action: open)
                    .buttonStyle(.momentsPrimary)
                    .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(Spacing.lg)
            .padding(.top, Spacing.xl * 3)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MomentsColor.background)
    }

    private func open() {
        if navigation.handle(text: link) {
            link = ""
            isLinkFocused = false
        } else {
            isRejected = true
            AccessibilityNotification.Announcement(String(localized: "That isn't a Moments event link.")).post()
        }
    }
}

private extension View {
    @ViewBuilder func linkInput() -> some View {
        #if os(iOS)
        keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
        #else
        self
        #endif
    }
}
