import Foundation

/// Which item and part a storage upload task is sending. It is the only
/// label a task carries (`"<ITEM-UUID>:<part>"`) — never the URL, which is a
/// credential — and names the part's file (`"<ITEM-UUID>-<part>"`), so both
/// can be found again after a relaunch.
struct PartTaskKey: Hashable, Sendable {
    let item: UUID
    let part: Int

    init(item: UUID, part: Int) {
        self.item = item
        self.part = part
    }

    /// Parses a label written by `label`; anything else is nil.
    init?(label: String?) {
        guard let label, let key = Self.parse(label, separator: ":"), key.label == label else { return nil }
        self = key
    }

    /// Parses a name written by `fileName`; anything else is nil.
    init?(fileName: String) {
        guard let key = Self.parse(fileName, separator: "-"), key.fileName == fileName else { return nil }
        self = key
    }

    var label: String { "\(item.uuidString):\(part)" }
    var fileName: String { "\(item.uuidString)-\(part)" }

    private static func parse(_ text: String, separator: Character) -> PartTaskKey? {
        guard let split = text.lastIndex(of: separator), let item = UUID(uuidString: String(text[..<split])),
              let part = Int(text[text.index(after: split)...]), part >= 1
        else { return nil }
        return PartTaskKey(item: item, part: part)
    }
}
