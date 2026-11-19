import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import UploadEngine

/// The upload queue's credentials lookup over the app's credential store.
/// Uploads need the guest's token: without one the guest must join again.
/// A store that can't be read now (the keychain before first unlock, or
/// any other read error) means "try later", never "join again", so a
/// background wake while the phone is locked doesn't fail every upload.
public func uploadCredentialsLookup(store: any EventCredentialStore) -> UploadQueue.CredentialsLookup {
    { rawSlug in
        guard let slug = EventSlug(rawSlug) else { return .missing }
        let stored: StoredEventCredentials?
        do {
            stored = try store.credentials(for: slug)
        } catch {
            return .unavailable
        }
        guard let stored, let token = stored.guestToken else { return .missing }
        return .found(EventCredentials(accessGrant: stored.validAccessGrant(), guestToken: token))
    }
}
