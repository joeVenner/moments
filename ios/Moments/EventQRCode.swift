import CoreImage
import CoreImage.CIFilterBuiltins
import DesignSystem
import SwiftUI

/// QR codes for event links. Modules are drawn in the page background
/// colour on a tile of the text colour: dark on light, as scanners expect,
/// using only the theme's tokens.
enum EventQRCode {
    /// Pixels per module: whole pixels keep every module the same width.
    static let pixelsPerModule: CGFloat = 8
    /// Quiet zone, in modules, around the code (the spec's minimum is 4).
    static let quietZoneModules: CGFloat = 4
    private static let context = CIContext()

    /// The code with its quiet zone, `pixelsPerModule` pixels per module, or
    /// nil when the text can't be encoded.
    static func image(for url: URL) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(url.absoluteString.utf8)
        filter.correctionLevel = "M"
        guard let generated = filter.outputImage else { return nil }
        // The generator adds its own one-module margin: measure the symbol
        // without it so the quiet zone is exactly `quietZoneModules`.
        let symbol = generated.extent.insetBy(dx: 1, dy: 1)
        let colored = generated.applyingFilter("CIFalseColor", parameters: [
            "inputColor0": ciColor(Palette.background),
            "inputColor1": ciColor(Palette.text),
        ])
        let padded = colored.clampedToExtent().cropped(to: symbol.insetBy(dx: -quietZoneModules, dy: -quietZoneModules))
        let scaled = padded.samplingNearest().transformed(by: CGAffineTransform(scaleX: pixelsPerModule, y: pixelsPerModule))
        return context.createCGImage(scaled, from: scaled.extent.integral)
    }

    private static func ciColor(_ rgb: RGB) -> CIColor {
        CIColor(red: CGFloat(rgb.red) / 255, green: CGFloat(rgb.green) / 255, blue: CGFloat(rgb.blue) / 255)
    }
}

/// A square, crisply scaled QR code for a link. The image is made once per
/// link, not on every render.
struct EventQRCodeView: View {
    private let image: CGImage?

    init(url: URL) {
        image = EventQRCode.image(for: url)
    }

    var body: some View {
        if let image {
            Image(decorative: image, scale: 1)
                .interpolation(.none)
                .resizable()
                .aspectRatio(1, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: Radius.card))
                .accessibilityElement()
                .accessibilityLabel(Text("QR code for the event link"))
                .accessibilityAddTraits(.isImage)
        }
    }
}
