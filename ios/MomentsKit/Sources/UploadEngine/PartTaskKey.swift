import CryptoKit
import Foundation

/// One part of one item, whatever attempt or session sends it.
struct PartSlot: Hashable, Sendable {
    let item: UUID
    let part: Int
}

/// One attempt at sending a part: which item, part and upload session, and
/// a fresh id per attempt. It is the only label a background task carries
/// (`"<ITEM>:<part>:<session tag>:<ATTEMPT>"`) — never the URL, which is a
/// credential — and names the attempt's file, so both can be found again
/// after a relaunch, and a late report from an old attempt can never be
/// taken for (or delete the file of) a newer one.
struct PartTaskKey: Hashable, Sendable {
    let item: UUID
    let part: Int
    /// `sessionTag(_:)` of the upload session the part belongs to.
    let session: String
    let attempt: UUID

    init(item: UUID, part: Int, session: String, attempt: UUID = UUID()) {
        self.item = item
        self.part = part
        self.session = session
        self.attempt = attempt
    }

    /// Parses a label written by `label`; anything else is nil.
    init?(label: String?) {
        guard let label, let key = Self.parse(label, separator: ":"), key.label == label else { return nil }
        self = key
    }

    /// Parses a name written by `fileName`; anything else is nil.
    init?(fileName: String) {
        guard let key = Self.parse(fileName, separator: "_"), key.fileName == fileName else { return nil }
        self = key
    }

    var slot: PartSlot { PartSlot(item: item, part: part) }
    var label: String { [item.uuidString, String(part), session, attempt.uuidString].joined(separator: ":") }
    var fileName: String { [item.uuidString, String(part), session, attempt.uuidString].joined(separator: "_") }

    /// A short, stable stand-in for an upload session id: 16 hex digits of
    /// its SHA-256.
    static func sessionTag(_ sessionID: String) -> String {
        SHA256.hash(data: Data(sessionID.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    private static func parse(_ text: String, separator: Character) -> PartTaskKey? {
        let fields = text.split(separator: separator, omittingEmptySubsequences: false)
        guard fields.count == 4, let item = UUID(uuidString: String(fields[0])), let part = Int(fields[1]), part >= 1,
              fields[2].count == 16, fields[2].allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              let attempt = UUID(uuidString: String(fields[3]))
        else { return nil }
        return PartTaskKey(item: item, part: part, session: String(fields[2]), attempt: attempt)
    }
}
