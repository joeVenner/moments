import Foundation
import Security

public enum KeychainError: Error, Equatable {
    case unexpectedStatus(OSStatus)
    /// The device is locked (and, for after-first-unlock items, has not been
    /// unlocked since boot).
    case unavailableWhileLocked
    case tooManyItems
    /// An item exists that this version can't read (e.g. a newer format
    /// after a downgrade); a partial change would have deleted it. The item
    /// is left untouched; a later join or unlock replaces it.
    case unreadableItem
}

/// SecItem plumbing shared by the keychain stores.
enum KeychainSupport {
    /// Updates the item matching `query`, or adds it. A concurrent add from
    /// another process between the two is answered with a second update.
    static func upsert(_ query: [String: Any], _ attributes: [String: Any]) throws {
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        guard updateStatus == errSecItemNotFound else { return try check(updateStatus) }
        let addStatus = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        if addStatus == errSecDuplicateItem {
            return try check(SecItemUpdate(query as CFDictionary, attributes as CFDictionary))
        }
        try check(addStatus)
    }

    /// Deletes the match; nothing to delete is fine.
    static func delete(_ query: [String: Any]) throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status != errSecItemNotFound else { return }
        try check(status)
    }

    static func check(_ status: OSStatus) throws {
        switch status {
        case errSecSuccess: return
        case errSecInteractionNotAllowed: throw KeychainError.unavailableWhileLocked
        default: throw KeychainError.unexpectedStatus(status)
        }
    }
}
