import DesignSystem
import FeatureGuest
import FeatureHost
import MomentsAPI
import SwiftUI

/// The Events tab, and the app's landing: what Moments is, the ways in
/// (scan, host, paste a link), the events joined on this phone, and how it
/// works.
struct HomeView: View {
    let navigation: AppNavigation
    let myEvents: MyEventsModel
    /// Shown in the join card instead of the usual hint, e.g. after a slideshow link.
    let notice: String?
    /// Opens the scanner; nil on a device without a camera.
    let onScan: (() -> Void)?
    let isScanBusy: Bool
    /// Shows the Hosting tab, where hosts sign in.
    var onHost: () -> Void = {}

    /// The host's account and events, for the Hosting tab and every host
    /// screen behind it.
    struct Host {
        let account: HostAccount
        let events: HostEventsModel
        let service: any HostService
        /// Loads moment thumbnails (host URLs carry their own signature).
        let mediaFetcher: MediaFetcher
        /// "Download everything" to Photos.
        let downloads: HostDownloads
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
            hero
            actions
            if !myEvents.entries.isEmpty {
                // The list carries its own "Your events" heading.
                MyEventsList(entries: myEvents.entries, open: navigation.open)
            }
            joinCard
            HowItWorks()
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

    /// The brand, the promise, and one line on how it works.
    private var hero: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack(spacing: Spacing.xs) {
                BrandMark(size: 28)
                Text(verbatim: "Moments")
                    .font(MomentsFont.display(.title2))
                    .foregroundStyle(MomentsColor.text)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: "Moments"))
            .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 0) {
                Text("Every guest's camera.")
                    .foregroundStyle(MomentsColor.text)
                Text("One shared album.")
                    .foregroundStyle(MomentsColor.accent)
            }
            .font(MomentsFont.display(.largeTitle))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
            Text(notice ?? String(localized: "Guests scan a QR code and share photos and videos from their phone, with nothing to install. You keep every moment, in full quality."))
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Scan (the one orange button) and Host.
    private var actions: some View {
        VStack(spacing: Spacing.sm) {
            if let onScan {
                Button(action: onScan) {
                    Label("Scan QR code", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(.momentsPrimary)
                .disabled(isScanBusy)
            }
            Button(action: onHost) {
                Label("Host an event", systemImage: "star")
            }
            .buttonStyle(.momentsSecondary)
        }
    }

    private var joinCard: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Have a link?")
                .font(MomentsFont.heading())
                .foregroundStyle(MomentsColor.text)
                .fixedSize(horizontal: false, vertical: true)
            Text("Paste the event's link from the invitation.")
                .font(MomentsFont.body(.subheadline))
                .foregroundStyle(MomentsColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
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
        .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).stroke(MomentsColor.border))
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

/// The lens mark: an orange ring around a dot, as on the app icon.
struct BrandMark: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle().strokeBorder(MomentsColor.accent, lineWidth: size * 0.17)
            Circle().fill(MomentsColor.accent).frame(width: size * 0.3, height: size * 0.3)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
