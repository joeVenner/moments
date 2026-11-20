import Foundation

/// Keychain access groups, from Info.plist (Config/Moments-Info.plist), which
/// gets them from the same build settings as the entitlements.
///
/// - `own`: the app's group, passed by its guest and host stores. It is the
///   first `keychain-access-groups` entry, so even a group-less add lands
///   there. The App Clip can't read it.
/// - `shared`: the group the App Clip writes a guest's credentials to.
enum KeychainGroups {
    static let own = group(Bundle.main.object(forInfoDictionaryKey: "MomentsKeychainGroup"))
    static let shared = group(Bundle.main.object(forInfoDictionaryKey: "MomentsSharedKeychainGroup"))

    /// Nil unless it starts with a team ID ("ABCDE12345."): an unsigned build
    /// leaves the prefix empty, and a group without it is never entitled.
    static func group(_ value: Any?) -> String? {
        guard let group = value as? String, group.wholeMatch(of: /[A-Z0-9]{10}\.[A-Za-z0-9.-]+/) != nil else { return nil }
        return group
    }
}
