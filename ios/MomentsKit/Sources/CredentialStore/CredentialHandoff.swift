import Foundation
import MomentsDomain

/// The App Clip keeps a guest's credentials in a keychain group it shares
/// with the app; the app keeps its own in a group the Clip can't read (host
/// sessions live there too). On launch, after the fresh-install reset, the
/// app moves what the Clip left into its own store, so a guest who joined
/// in the Clip keeps their nickname, uploads and points in the app.
public enum CredentialHandoff {
    /// How long a Clip entry waits for the app. iOS keeps keychain items
    /// after the Clip and app are deleted, so on a phone that changed hands an
    /// old entry would otherwise make the next owner that guest.
    public static let handoffWindow: TimeInterval = 7 * 24 * 60 * 60

    /// A stamp this far ahead of `now` still counts (a clock set back).
    public static let futureTolerance: TimeInterval = 60 * 60

    /// Moves each recently joined event from `shared` into `own`.
    ///
    /// - Imported: entries with a guest token and an event, handed over
    ///   within `handoffWindow` of `now` (up to `futureTolerance` ahead).
    ///   An expired private-event grant is dropped on the way.
    /// - Deleted unread: entries handed over too long ago, too far ahead, or
    ///   never stamped (no released Clip wrote before the stamp existed).
    /// - Left alone: entries this version can't read (their stamp can't be
    ///   read either, and one may hold a newer build's token), and recent
    ///   ones it can't use (no guest token or event) until they age out.
    /// - A shared entry is deleted only once `own` holds a guest token for
    ///   that event: a failed save leaves it for the next launch.
    /// - What the app already has for an event wins; the Clip's copy goes
    ///   (it can only be older: the Clip can't run once the app is installed).
    /// - `own` reads an entry it can't decode as missing, so the Clip's copy
    ///   replaces it, as a new join would.
    ///
    /// Every event is tried; the first error is thrown at the end.
    /// - Returns: the events whose credentials were copied into `own`.
    @discardableResult
    public static func importFromClip(
        _ shared: some EventCredentialStore, into own: some EventCredentialStore, now: Date = .now
    ) throws -> [EventSlug] {
        var imported: [EventSlug] = []
        var firstError: (any Error)?
        for slug in try shared.storedSlugs() {
            do {
                guard var handed = try shared.credentials(for: slug) else { continue }
                guard let handedOverAt = handed.handedOverAt,
                      handedOverAt <= now.addingTimeInterval(futureTolerance),
                      now.timeIntervalSince(handedOverAt) <= handoffWindow
                else {
                    try shared.removeCredentials(for: slug)
                    continue
                }
                guard handed.guestToken != nil, handed.eventID != nil else { continue }
                if let existing = try own.credentials(for: slug) {
                    // Keep the app's entry; a token-less one isn't merged.
                    guard existing.guestToken != nil else { continue }
                } else {
                    handed.handedOverAt = nil
                    if handed.validAccessGrant(at: now) == nil {
                        handed.accessGrant = nil
                        handed.accessGrantExpiresAt = nil
                    }
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
