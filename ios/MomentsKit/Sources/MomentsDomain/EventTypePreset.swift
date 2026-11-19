import Foundation

/// The event types offered as one-tap choices. The stored values match the
/// web's templates (`src/client/lib/eventTemplates.ts`), which also pick
/// each event's banner scene from them; anything else is a custom type.
public enum EventTypePreset: String, CaseIterable, Sendable, Identifiable {
    case wedding, birthday, graduation, corporate, party

    public var id: String { rawValue }

    /// What the server stores, never translated, so web and app agree.
    public var storedValue: String {
        switch self {
        case .wedding: "Wedding"
        case .birthday: "Birthday"
        case .graduation: "Graduation"
        case .corporate: "Corporate"
        case .party: "Party"
        }
    }

    /// The preset a stored type stands for, ignoring case and outer spaces;
    /// nil for a custom type (or none).
    public static func matching(_ type: String) -> EventTypePreset? {
        let key = type.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return allCases.first { $0.storedValue.lowercased() == key }
    }

    /// A type someone wrote themselves: not empty and no preset.
    public static func isCustom(_ type: String) -> Bool {
        !type.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && matching(type) == nil
    }
}
