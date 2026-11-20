import CredentialStore
import Foundation

/// Where the app keeps credentials, from Info.plist (Config/Moments-Info.plist),
/// which gets the names from the same build settings as the entitlements.
///
/// - `own`: the app's keychain group, passed by its guest and host stores. It
///   is the only `keychain-access-groups` entry, so a group-less add lands
///   there too.
/// - `appGroup`: the App Group container the App Clip hands a guest over in
///   (an App Clip can't share keychain groups).
enum CredentialGroups {
    static let own = KeychainAccessGroup.validated(Bundle.main.object(forInfoDictionaryKey: "MomentsKeychainGroup") as? String)
    static let appGroup = Bundle.main.object(forInfoDictionaryKey: "MomentsAppGroup") as? String
}
