import AVFoundation
import DesignSystem
import FeatureGuest
import FeatureHost
import SwiftUI
import UIKit

/// The app's two places, with Scan between them in the bottom bar.
enum AppTab: Hashable {
    case events, hosting
}

/// The home of the app: the Events and Hosting tabs under one bottom bar,
/// whose middle button scans an event's QR code from either.
struct AppShell: View {
    let navigation: AppNavigation
    let myEvents: MyEventsModel
    let host: HomeView.Host
    let notice: String?

    @Environment(\.scenePhase) private var scenePhase
    @State private var tab = AppTab.events
    /// Hosting stays unbuilt until first opened, so a guest's launch never
    /// loads host events.
    @State private var hasOpenedHosting = false
    @State private var scanSheet: ScanSheet?
    // Read now, so the Scan button is there from the first frame.
    @State private var cameraAccess = CameraAccess.current
    @State private var isRequestingCamera = false
    @State private var isKeyboardUp = false

    var body: some View {
        // Both tabs stay alive, so each keeps its scroll and navigation.
        ZStack {
            HomeView(
                navigation: navigation, myEvents: myEvents, notice: notice,
                onScan: scanAction, isScanBusy: isRequestingCamera
            )
            .tabContent(isSelected: tab == .events)
            if hasOpenedHosting {
                HostingTab(host: host).tabContent(isSelected: tab == .hosting)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            // Out of the way while typing, as the system tab bar does.
            if !isKeyboardUp {
                AppTabBar(selection: $tab, onScan: scanAction, isScanBusy: isRequestingCamera)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            isKeyboardUp = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            isKeyboardUp = false
        }
        .background(MomentsColor.background.ignoresSafeArea())
        .onChange(of: tab) {
            // Typing in a tab that just went out of sight would leave its keyboard up.
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            switch tab {
            case .hosting:
                hasOpenedHosting = true
                host.account.refresh()
            case .events:
                Task { await myEvents.load() }
            }
        }
        .onAppear { cameraAccess = CameraAccess.current }
        // Picks up expiry and a keychain that was locked at launch.
        .onChange(of: scenePhase, initial: true) {
            if scenePhase == .active { host.account.refresh() }
        }
        .fullScreenCover(item: $scanSheet) { sheet in
            switch sheet {
            case .scanner:
                QRScannerSheet { text in
                    guard navigation.handle(text: text) else { return false }
                    scanSheet = nil
                    return true
                } onCancel: {
                    scanSheet = nil
                } onUnavailable: {
                    scanSheet = .denied
                }
            case .denied:
                CameraDeniedSheet { scanSheet = nil } onGranted: { scanSheet = .scanner }
            }
        }
    }

    /// Opens the scanner; nil on a device without a camera.
    private var scanAction: (() -> Void)? {
        guard cameraAccess != .unsupported else { return nil }
        return { startScanning() }
    }

    private enum ScanSheet: String, Identifiable {
        case scanner, denied
        var id: String { rawValue }
    }

    private func startScanning() {
        cameraAccess = CameraAccess.current
        switch cameraAccess {
        case .unsupported: return
        case .granted: scanSheet = .scanner
        case .denied: scanSheet = .denied
        case .notDetermined:
            isRequestingCamera = true
            Task {
                let isGranted = await AVCaptureDevice.requestAccess(for: .video)
                isRequestingCamera = false
                cameraAccess = CameraAccess.current
                scanSheet = isGranted ? .scanner : .denied
            }
        }
    }
}

/// Events · Scan · Hosting.
struct AppTabBar: View {
    @Binding var selection: AppTab
    /// Nil on a device without a camera: the middle button goes.
    let onScan: (() -> Void)?
    let isScanBusy: Bool

    var body: some View {
        HStack(alignment: .center) {
            tabButton(.events, title: "Events", systemImage: "calendar", selectedImage: "calendar")
            Spacer(minLength: Spacing.md)
            if let onScan {
                Button(action: onScan) {
                    Image(systemName: "qrcode.viewfinder")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(MomentsColor.onAccent)
                        .frame(width: 56, height: 56)
                        .background(MomentsColor.accent, in: Circle())
                }
                .disabled(isScanBusy)
                .accessibilityLabel(Text("Scan a QR code"))
                Spacer(minLength: Spacing.md)
            }
            tabButton(.hosting, title: "Hosting", systemImage: "star", selectedImage: "star.fill")
        }
        .padding(.horizontal, Spacing.xl)
        .padding(.vertical, Spacing.xs)
        .frame(maxWidth: .infinity)
        .background(MomentsColor.background.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { MomentsColor.border.frame(height: 1) }
        // A tab bar keeps its size; long-press shows the label large instead.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private func tabButton(_ tab: AppTab, title: LocalizedStringKey, systemImage: String, selectedImage: String) -> some View {
        let isSelected = selection == tab
        return Button { selection = tab } label: {
            VStack(spacing: Spacing.xxs) {
                Image(systemName: isSelected ? selectedImage : systemImage)
                    .font(.system(size: 22))
                    // Symbols differ in height; a fixed box keeps the labels level.
                    .frame(height: 28)
                Text(title)
                    .font(MomentsFont.caption(.caption2))
                    .fontWeight(isSelected ? .semibold : .regular)
            }
            .foregroundStyle(isSelected ? MomentsColor.accent : MomentsColor.textMuted)
            .frame(minWidth: 72, minHeight: Radius.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityShowsLargeContentViewer()
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

/// The Hosting tab: the host's events once signed in, otherwise an
/// invitation to sign in.
struct HostingTab: View {
    let host: HomeView.Host
    @State private var isShowingSignIn = false

    var body: some View {
        Group {
            if case .signedIn = host.account.state {
                // Signing out swaps this for the welcome below.
                HostEventsView(host: host, onClose: nil)
            } else {
                HostingWelcome { isShowingSignIn = true }
            }
        }
        .onAppear { host.account.refresh() }
        .sheet(isPresented: $isShowingSignIn) {
            HostSignInView(account: host.account) {
                isShowingSignIn = false
            } onCancel: {
                isShowingSignIn = false
            }
        }
    }
}

/// What hosting is, for someone who hasn't signed in.
struct HostingWelcome: View {
    let onSignIn: () -> Void

    var body: some View {
        ScrollView { content }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(MomentsColor.background)
    }

    /// Everything without the scroll view (also rendered by screenshot tests).
    var content: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            Text("Hosting")
                .font(MomentsFont.display())
                .foregroundStyle(MomentsColor.text)
                .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text("Host your own event")
                    .font(MomentsFont.heading())
                    .foregroundStyle(MomentsColor.text)
                    .fixedSize(horizontal: false, vertical: true)
                Text("A QR code for the tables, one live album for every guest, and every photo and video kept in full quality.")
                    .font(MomentsFont.body())
                    .foregroundStyle(MomentsColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Sign in to host", action: onSignIn)
                    .buttonStyle(.momentsPrimary)
            }
            .padding(Spacing.md)
            .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.sheet))
            .overlay(RoundedRectangle(cornerRadius: Radius.sheet).stroke(MomentsColor.border))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Spacing.lg)
        .padding(.top, Spacing.xl)
    }
}

private extension View {
    /// A tab's content: hidden from sight, touch and VoiceOver when not selected.
    func tabContent(isSelected: Bool) -> some View {
        opacity(isSelected ? 1 : 0)
            .allowsHitTesting(isSelected)
            .accessibilityHidden(!isSelected)
    }
}
