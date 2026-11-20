import CoreTransferable
import DesignSystem
import MomentsDomain
import SwiftUI
import UniformTypeIdentifiers

/// An A6 flyer for the host to print or send: the event's name, the QR code
/// and its link. Printed pages are inverted (the light text token as paper,
/// the page token as ink) so a print costs little ink and stays on theme.
/// The PIN is never printed: the app doesn't know it, and a flyer on a wall
/// is public.
struct EventFlyer: Transferable {
    let title: String
    let slug: String
    let url: URL
    let isPrivate: Bool

    /// A6 in points (105 × 148 mm).
    static let pageSize = CGSize(width: 297.64, height: 419.53)

    init(event: Event, url: URL) {
        title = event.title
        slug = event.slug
        self.url = url
        isPrivate = event.accessMode == .private
    }

    /// "party-flyer.pdf". The slug comes from the server: anything but
    /// letters, digits, "-" and "_" is dropped, so it can't name a path.
    var fileName: String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let safe = String(String.UnicodeScalarView(slug.unicodeScalars.filter { $0.isASCII && allowed.contains($0) }))
        return safe.isEmpty ? "flyer.pdf" : "\(safe.prefix(80))-flyer.pdf"
    }

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .pdf) { flyer in
            SentTransferredFile(try await flyer.writePDF())
        }
    }

    /// Renders the flyer into a one-page PDF in its own temporary folder, so
    /// two shares never write the same file (the system clears tmp).
    @MainActor func writePDF() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appending(path: fileName, directoryHint: .notDirectory)
        let renderer = ImageRenderer(content: EventFlyerPage(flyer: self))
        renderer.proposedSize = ProposedViewSize(Self.pageSize)
        var failure: Error?
        renderer.render { size, draw in
            var box = CGRect(origin: .zero, size: size)
            guard let pdf = CGContext(file as CFURL, mediaBox: &box, nil) else {
                failure = CocoaError(.fileWriteUnknown)
                return
            }
            pdf.beginPDFPage(nil)
            draw(pdf)
            pdf.endPDFPage()
            pdf.closePDF()
        }
        if let failure { throw failure }
        // render calls back only when it has something to draw.
        guard FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) else {
            throw CocoaError(.fileWriteUnknown)
        }
        return file
    }
}

/// The printed page itself; fixed size and text size so every flyer matches.
struct EventFlyerPage: View {
    let flyer: EventFlyer

    var body: some View {
        VStack(spacing: 14) {
            Text("You're invited")
                .font(.system(size: 11, weight: .semibold))
                .textCase(.uppercase)
                .tracking(1)
            Text(verbatim: flyer.title)
                .font(.system(size: 24, weight: .semibold, design: .serif))
                .multilineTextAlignment(.center)
                .lineLimit(3)
                .minimumScaleFactor(0.6)
            MomentsColor.accent.frame(width: 40, height: 3)
            Text("Scan to share your photos and videos")
                .font(.system(size: 12))
                .multilineTextAlignment(.center)
            EventQRCodeView(url: flyer.url)
                .frame(width: 170, height: 170)
            Text(verbatim: flyer.url.absoluteString)
                .font(.system(size: 9))
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
            if flyer.isPrivate {
                Text("Private event: ask the host for the PIN.")
                    .font(.system(size: 10, weight: .semibold))
                    .multilineTextAlignment(.center)
            }
            Spacer(minLength: 0)
            Text(verbatim: "Moments")
                .font(.system(size: 10, weight: .semibold, design: .serif))
        }
        .foregroundStyle(MomentsColor.background)
        .padding(24)
        .frame(width: EventFlyer.pageSize.width, height: EventFlyer.pageSize.height)
        .background(MomentsColor.text)
        .environment(\.dynamicTypeSize, .large)
    }
}
