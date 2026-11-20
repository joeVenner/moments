import CredentialStore
import Foundation

/// Keychain access groups, from Info.plist (Config/Moments-Info.plist), which
/// gets them from the same build settings as the entitlements.
///
/// - `own`: the app's group, passed by its guest and host stores. It is the
///   first `keychain-access-groups` entry, so even a group-less add lands
///   there. The App Clip can't read it.
/// - `shared`: the group the App Clip writes a guest's credentials to.
enum KeychainGroups {
    static let own = KeychainAccessGroup.validated(Bundle.main.object(forInfoDictionaryKey: "MomentsKeychainGroup") as? String)
    static let shared = KeychainAccessGroup.validated(Bundle.main.object(forInfoDictionaryKey: "MomentsSharedKeychainGroup") as? String)
}
