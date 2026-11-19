import AVFoundation
import DesignSystem
import FeatureGuest
import SwiftUI

/// The home screen: the events joined on this phone, then opening another
/// event from its link (one that arrived by message or a copied URL; the
/// camera opens QR links directly).
struct HomeView: View {
    let navigation: AppNavigation
    let myEvents: MyEventsModel
    /// Shown above the link field, e.g. after a slideshow link.
    let notice: String?

    @State private var scanSheet: ScanSheet?
    @State private var cameraAccess = CameraAccess.unsupported
    @State private var isRequestingCamera = false
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
                if !myEvents.entries.isEmpty { MyEventsList(entries: myEvents.entries, open: navigation.open) }
                if myEvents.phase == .unavailable {
                    // The keychain is locked (or unreadable); pull to refresh retries.
                    Text("Your events can't be shown right now. Pull down to try again.")
                        .font(MomentsFont.caption())
                        .foregroundStyle(MomentsColor.textMuted)
                        .multilineTextAlignment(.center)
                }
                Text(notice ?? String(localized: "Scan the event's QR code with your camera, or paste its link here."))
                    .font(MomentsFont.body())
                    .foregroundStyle(MomentsColor.textMuted)
                    .multilineTextAlignment(.center)
                if cameraAccess != .unsupported {
                    Button(action: startScanning) {
                        Label("Scan QR code", systemImage: "qrcode.viewfinder")
                    }
                    .buttonStyle(.momentsPrimary)
                    .disabled(isRequestingCamera)
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
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                // One orange button: Scan when there is one, otherwise this.
                if cameraAccess == .unsupported {
                    openButton.buttonStyle(.momentsPrimary)
                } else {
                    openButton.buttonStyle(.momentsSecondary)
                }
            }
            .padding(Spacing.lg)
            .padding(.top, Spacing.xl * 3)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MomentsColor.background)
        // Reloads each time home shows, e.g. after joining or leaving an event.
        .task { await myEvents.load() }
        .onAppear { cameraAccess = CameraAccess.current }
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
        .refreshable { await myEvents.load() }
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

