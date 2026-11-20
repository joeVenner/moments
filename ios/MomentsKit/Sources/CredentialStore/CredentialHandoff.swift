import MomentsDomain

/// The App Clip keeps a guest's credentials in a keychain group it shares
/// with the app; the app keeps its own in a group the Clip can't read (host
/// sessions live there too). On launch, after the fresh-install reset, the
/// app moves what the Clip left into its own store, so a guest who joined
/// in the Clip keeps their nickname, uploads and points in the app.
public enum CredentialHandoff {
    /// Moves each joined event from `shared` into `own`.
    ///
    /// - A shared entry is deleted only once `own` holds a guest token for
    ///   that event: a failed save leaves it for the next launch.
    /// - What the app already has for an event wins; the Clip's copy goes
    ///   (it can only be older: the Clip can't run once the app is installed).
    /// - `own` reads an entry it can't decode as missing, so the Clip's copy
    ///   replaces it, as a new join would.
    /// - Entries without a guest token, or that this version can't read,
    ///   are left alone.
    ///
    /// Every event is tried; the first error is thrown at the end.
    /// - Returns: the events whose credentials were copied into `own`.
    @discardableResult
    public static func importFromClip(_ shared: some EventCredentialStore, into own: some EventCredentialStore) throws -> [EventSlug] {
        var imported: [EventSlug] = []
        var firstError: (any Error)?
        for slug in try shared.storedSlugs() {
            do {
                guard let handed = try shared.credentials(for: slug), handed.guestToken != nil else { continue }
                if let existing = try own.credentials(for: slug) {
                    // Keep the app's entry; a token-less one isn't merged.
                    guard existing.guestToken != nil else { continue }
                } else {
                    try own.save(handed, for: slug)
                    guard try own.credentials(for: slug)?.guestToken != nil else { continue }
                    imported.append(slug)
                }
                try shared.removeCredentials(for: slug)
            } catch {
                if firstError == nil { firstError = error }
            }
        }
        if let firstError { throw firstError }
        return imported
    }
}
