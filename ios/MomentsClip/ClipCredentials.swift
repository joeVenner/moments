import CredentialStore
import Foundation

/// The only place the Clip builds a credential store. The guest lives in
/// memory for the session and is copied, stamped for the handover, to the
/// App Group file the app picks up. The Clip never touches the keychain (an
/// App Clip can't share keychain groups) or host sessions. Without the App
/// Group (an unsigned build) joining still works; the app just can't pick
/// the guest up.
enum ClipCredentials {
    static let appGroup = Bundle.main.object(forInfoDictionaryKey: "MomentsAppGroup") as? String

    static func store(appGroup: String? = appGroup) -> ClipSessionStore {
        ClipSessionStore(mirror: FileEventCredentialStore.handover(appGroup: appGroup).map { HandoverStampingStore($0) })
    }
}
