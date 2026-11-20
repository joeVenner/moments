import CredentialStore
import Foundation
import MomentsDomain
import Security
import Testing
@testable import Moments

private let party = EventSlug("party")!

/// The App Clip handover on the simulator: the app's keychain group (real
/// keychain, a test service per test) and the App Group file the Clip
/// writes (a temporary folder, never the real container).
@Suite @MainActor struct ClipHandoverTests {
    private let own: String
    private let folder = FileManager.default.temporaryDirectory
        .appending(path: "moments-handover-\(UUID().uuidString)", directoryHint: .isDirectory)

    init() throws {
        own = try #require(CredentialGroups.own, "Info.plist has no keychain group")
    }

    /// The app's own keychain store on a test service, and a Clip-side file.
    private func stores(_ name: String) -> (own: KeychainEventCredentialStore, shared: FileEventCredentialStore) {
        (AppEnvironment.credentialStores(service: "moments.tests.handoff.\(name)").own, FileEventCredentialStore(directory: folder))
    }

    /// A fresh-install marker store; `forget` deletes it after the test.
    private func freshInstall(_ name: String) throws -> (defaults: UserDefaults, forget: () -> Void) {
        let suite = "moments.tests.handoff.\(name)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        return (defaults, { defaults.removePersistentDomain(forName: suite) })
    }

    private func joined(_ token: String) -> StoredEventCredentials {
        StoredEventCredentials(eventID: "e1", guestToken: token, participantID: "p1", nickname: "Lea")
    }

    @Test func theKeychainGroupIsThisAppsOwn() throws {
        let appID = try #require(Bundle.main.bundleIdentifier)
        #expect(own.hasSuffix(".\(appID)") && own.count > appID.count + 1)
    }

    @Test func theAppReachesTheHandoverContainer() throws {
        let group = try #require(CredentialGroups.appGroup)
        #expect(FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) != nil)
        #expect(AppEnvironment.credentialStores().handover != nil)
    }

    @Test func itemsSavedWithoutAGroupStayInTheAppsGroup() throws {
        // Host sessions are saved without a group: the app's own is the default.
        let service = "moments.tests.handoff.default"
        let store = KeychainEventCredentialStore(service: service)
        defer { try? store.removeAll() }
        try store.save(joined("gt"), for: party)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        #expect(SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess)
        #expect((result as? [String: Any])?[kSecAttrAccessGroup as String] as? String == own)
    }

    @Test func aFreshInstallDropsOldGuestsButKeepsTheClipsOne() throws {
        let (ownStore, sharedStore) = stores("fresh")
        defer { try? ownStore.removeAll(); try? FileManager.default.removeItem(at: folder) }
        let wedding = EventSlug("wedding")!
        try ownStore.save(joined("gt_old"), for: wedding)
        // As the Clip saves it: stamped now.
        try HandoverStampingStore(sharedStore).save(joined("gt_clip"), for: party)
        let install = try freshInstall("fresh")
        defer { install.forget() }
        AppEnvironment.prepareCredentials(own: ownStore, handover: sharedStore, defaults: install.defaults)
        #expect(try ownStore.storedSlugs() == [party])
        #expect(try ownStore.credentials(for: party) == joined("gt_clip"))
        #expect(try sharedStore.storedSlugs().isEmpty)
    }

    @Test func laterLaunchesKeepTheAppsGuestsAndStillImport() throws {
        let (ownStore, sharedStore) = stores("later")
        defer { try? ownStore.removeAll(); try? FileManager.default.removeItem(at: folder) }
        let install = try freshInstall("later")
        defer { install.forget() }
        let defaults = install.defaults
        AppEnvironment.prepareCredentials(own: ownStore, handover: sharedStore, defaults: defaults)
        let wedding = EventSlug("wedding")!
        try ownStore.save(joined("gt_app"), for: wedding)
        try HandoverStampingStore(sharedStore).save(joined("gt_clip"), for: party)
        AppEnvironment.prepareCredentials(own: ownStore, handover: sharedStore, defaults: defaults)
        #expect(try ownStore.storedSlugs() == [party, wedding])
        #expect(try sharedStore.storedSlugs().isEmpty)
    }

    @Test func aFailedImportAsksToBeTriedAgain() throws {
        let (ownStore, _) = stores("retry")
        defer { try? ownStore.removeAll(); try? FileManager.default.removeItem(at: folder) }
        let install = try freshInstall("retry")
        defer { install.forget() }
        // A folder where the file should be: the import can't read it, as
        // with a locked phone.
        try FileManager.default.createDirectory(at: folder.appending(path: "event-credentials.json"), withIntermediateDirectories: true)
        let unreadable = FileEventCredentialStore(directory: folder)
        #expect(!AppEnvironment.prepareCredentials(own: ownStore, handover: unreadable, defaults: install.defaults))
        try FileManager.default.removeItem(at: folder)
        #expect(AppEnvironment.prepareCredentials(own: ownStore, handover: unreadable, defaults: install.defaults))
        #expect(AppEnvironment.prepareCredentials(own: ownStore, handover: nil, defaults: install.defaults))
    }

    @Test func aGroupThisAppIsntEntitledToIsRefused() throws {
        // The simulator enforces access groups, and the group the App Clip
        // once shared (it can't: App Clips can't hold keychain groups) is gone.
        for group in [own + ".shared", own + ".other"] {
            let store = KeychainEventCredentialStore(service: "moments.tests.handoff.foreign", accessGroup: group)
            defer { try? store.removeAll() }
            #expect(throws: (any Error).self) { try store.save(joined("gt"), for: party) }
        }
    }
}
