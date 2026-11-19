import DesignSystem
import FeatureGuest
import FeatureHost
import MomentsAPI
import SwiftUI

/// The Events tab: a card to join an event (scan its QR code or paste its
/// link), then the events joined on this phone.
struct HomeView: View {
    let navigation: AppNavigation
    let myEvents: MyEventsModel
    /// Shown in the join card instead of the usual hint, e.g. after a slideshow link.
    let notice: String?
    /// Opens the scanner; nil on a device without a camera.
    let onScan: (() -> Void)?
    let isScanBusy: Bool

    /// The host's account and events, for the Hosting tab and every host
    /// screen behind it.
    struct Host {
        let account: HostAccount
        let events: HostEventsModel
        let service: any HostService
        /// Loads moment thumbnails (host URLs carry their own signature).
        let mediaFetcher: MediaFetcher
    }

    @State private var link = ""
    @State private var isRejected = false
    @FocusState private var isLinkFocused: Bool

    var body: some View {
        // Scrolls only when needed: large text sizes with the keyboard up.
        ScrollView { content }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(MomentsColor.background)
            // Reloads each time home is built (e.g. back from an event, which
            // replaces the whole shell) and on returning to the Events tab.
            .task { await myEvents.load() }
            .refreshable { await myEvents.load() }
    }

    /// Everything without the scroll view (also rendered by screenshot tests).
    var content: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            Text("Moments")
                .font(MomentsFont.display())
                .foregroundStyle(MomentsColor.text)
                .accessibilityAddTraits(.isHeader)
            joinCard
            if !myEvents.entries.isEmpty {
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text("Your events")
                        .font(MomentsFont.heading())
                        .foregroundStyle(MomentsColor.text)
                        .accessibilityAddTraits(.isHeader)
                    MyEventsList(entries: myEvents.entries, open: navigation.open)
                }
            }
            if myEvents.phase == .unavailable {
                // The keychain is locked (or unreadable); pull to refresh retries.
                Text("Your events can't be shown right now. Pull down to try again.")
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Spacing.lg)
        .padding(.top, Spacing.xl)
        .padding(.bottom, Spacing.lg)
    }

    private var joinCard: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("At an event?")
                .font(MomentsFont.heading())
                .foregroundStyle(MomentsColor.text)
                .fixedSize(horizontal: false, vertical: true)
            Text(notice ?? String(localized: "Scan the QR code on the table or the invitation, or paste the event's link."))
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            if let onScan {
                Button(action: onScan) {
                    Label("Scan QR code", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(.momentsPrimary)
                .disabled(isScanBusy)
            }
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
            }
            // One orange button: Scan when there is one, otherwise this.
            if onScan == nil {
                openButton.buttonStyle(.momentsPrimary)
            } else {
                openButton.buttonStyle(.momentsSecondary)
            }
        }
        .padding(Spacing.md)
        .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.sheet))
        .overlay(RoundedRectangle(cornerRadius: Radius.sheet).stroke(MomentsColor.border))
    }

    private var openButton: some View {
        Button("Open event", action: open)
            .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
