import AVFoundation
import DesignSystem
import SwiftUI
#if canImport(VisionKit)
import VisionKit
#endif

/// Decides which scanned codes to act on. The camera reports the same code
/// many times a second; each code that isn't a Moments link is reported once.
/// Once a code has opened an event, nothing else is tried (the sheet is
/// still closing and the camera keeps reporting).
struct ScanFilter {
    /// Per-process hashes, not the codes: a refused code may still hold an invite.
    private var rejected: Set<Int> = []
    private var hasAccepted = false

    /// Whether `payload` should be tried; report the outcome afterwards.
    func shouldTry(_ payload: String) -> Bool {
        !hasAccepted && !payload.isEmpty && !rejected.contains(payload.hashValue)
    }

    mutating func rejected(_ payload: String) {
        // Bounded: a sheet full of odd codes can't grow this forever.
        if rejected.count >= 64 { rejected.removeAll() }
        rejected.insert(payload.hashValue)
    }

    mutating func accepted() {
        hasAccepted = true
    }
}

/// What the Scan button may do on this device.
enum CameraAccess: Equatable {
    /// No scanner here (simulator, or a device without the hardware): no button.
    case unsupported
    case notDetermined, granted, denied

    @MainActor static var current: CameraAccess {
        #if canImport(VisionKit) && os(iOS)
        from(
            isSupported: DataScannerViewController.isSupported,
            status: AVCaptureDevice.authorizationStatus(for: .video),
            isAvailable: DataScannerViewController.isAvailable
        )
        #else
        .unsupported
        #endif
    }

    /// `isAvailable` is false when allowed but blocked anyway (Screen Time,
    /// device management): treated like a refusal.
    static func from(isSupported: Bool, status: AVAuthorizationStatus, isAvailable: Bool) -> CameraAccess {
        guard isSupported else { return .unsupported }
        switch status {
        case .authorized: return isAvailable ? .granted : .denied
        case .notDetermined: return .notDetermined
        default: return .denied
        }
    }
}

/// Full-screen scanner sheet: camera, a hint, and Cancel. A code that is a
/// Moments event link opens it (the caller dismisses the sheet).
struct QRScannerSheet: View {
    /// Returns whether the scanned text was an event link it opened.
    let onScan: (String) -> Bool
    let onCancel: () -> Void
    /// The camera couldn't start (access revoked meanwhile).
    let onUnavailable: () -> Void
    @State private var filter = ScanFilter()
    @State private var isShowingRejection = false

    var body: some View {
        ZStack(alignment: .bottom) {
            #if canImport(VisionKit) && os(iOS)
            DataScanner(onPayload: handle, onUnavailable: onUnavailable)
                .ignoresSafeArea()
                .accessibilityLabel(Text("Camera"))
            #endif
            VStack(spacing: Spacing.sm) {
                Label {
                    Text(isShowingRejection ? "That QR code isn't a Moments event." : "Point your camera at the event's QR code.")
                } icon: {
                    Image(systemName: isShowingRejection ? "exclamationmark.triangle" : "qrcode.viewfinder")
                        .accessibilityHidden(true)
                }
                .font(MomentsFont.body())
                .foregroundStyle(isShowingRejection ? MomentsColor.accent : MomentsColor.text)
                .multilineTextAlignment(.center)
                .padding(Spacing.md)
                .background(MomentsColor.surface.opacity(0.9), in: RoundedRectangle(cornerRadius: Radius.card))
                Button("Cancel", action: onCancel)
                    .buttonStyle(.momentsSecondary)
            }
            .padding(Spacing.lg)
        }
        .background(MomentsColor.background)
    }

    private func handle(_ payload: String) {
        guard filter.shouldTry(payload) else { return }
        if onScan(payload) { return filter.accepted() }
        filter.rejected(payload)
        isShowingRejection = true
        AccessibilityNotification.Announcement(String(localized: "That QR code isn't a Moments event.")).post()
    }
}

/// Shown instead of the scanner when camera access was refused.
struct CameraDeniedSheet: View {
    let onClose: () -> Void
    /// Access was turned on in Settings meanwhile.
    let onGranted: () -> Void
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        // Scrolls at the largest text sizes instead of clipping.
        GeometryReader { proxy in
            ScrollView {
                content.frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(MomentsColor.background.ignoresSafeArea())
        // Back from Settings with the camera allowed: go straight to scanning.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, CameraAccess.current == .granted { onGranted() }
        }
    }

    private var content: some View {
        VStack(spacing: Spacing.md) {
            Image(systemName: "camera.fill")
                .font(.largeTitle)
                .foregroundStyle(MomentsColor.textMuted)
                .accessibilityHidden(true)
            Text("Camera access is off")
                .font(MomentsFont.display(.title2))
                .foregroundStyle(MomentsColor.text)
                .accessibilityAddTraits(.isHeader)
            Text("Allow camera access in Settings to scan event QR codes, or paste the event's link instead.")
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
                .multilineTextAlignment(.center)
            #if os(iOS)
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }
            .buttonStyle(.momentsPrimary)
            #endif
            Button("Cancel", action: onClose)
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
                .frame(minHeight: Radius.minimumTapTarget)
        }
        .padding(Spacing.lg)
    }
}

#if canImport(VisionKit) && os(iOS)
/// VisionKit's scanner, QR codes only, reporting each code's text.
private struct DataScanner: UIViewControllerRepresentable {
    let onPayload: (String) -> Void
    let onUnavailable: () -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            // The moving highlight is decoration; Reduce Motion drops it.
            isHighlightingEnabled: !UIAccessibility.isReduceMotionEnabled
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.onPayload = onPayload
        context.coordinator.onUnavailable = onUnavailable
        context.coordinator.start(scanner)
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onPayload: onPayload, onUnavailable: onUnavailable) }

    @MainActor final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onPayload: (String) -> Void
        var onUnavailable: () -> Void
        private var hasRetried = false

        init(onPayload: @escaping (String) -> Void, onUnavailable: @escaping () -> Void) {
            self.onPayload = onPayload
            self.onUnavailable = onUnavailable
        }

        /// Starting before the view is in a window can throw; retry once on
        /// the next turn, then report the camera as unavailable.
        func start(_ scanner: DataScannerViewController) {
            guard !scanner.isScanning else { return }
            do {
                try scanner.startScanning()
            } catch {
                guard !hasRetried else { return onUnavailable() }
                hasRetried = true
                Task { @MainActor in self.start(scanner) }
            }
        }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            report(items)
        }

        func dataScanner(_ scanner: DataScannerViewController, didUpdate items: [RecognizedItem], allItems: [RecognizedItem]) {
            report(items)
        }

        func dataScanner(_ scanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            report([item])
        }

        private func report(_ items: [RecognizedItem]) {
            for case let .barcode(barcode) in items {
                if let payload = barcode.payloadStringValue { onPayload(payload) }
            }
        }
    }
}
#endif
