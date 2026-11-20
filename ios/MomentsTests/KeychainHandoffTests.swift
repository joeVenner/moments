import CredentialStore
import Foundation
import MomentsDomain
import Security
import Testing
@testable import Moments

private let party = EventSlug("party")!

/// The keychain groups behind the App Clip handoff, on the simulator's real
/// keychain. Each test uses its own service, never the app's.
@Suite @MainActor struct KeychainHandoffTests {
    private let own: String
    private let shared: String

    init() throws {
        own = try #require(KeychainGroups.own, "Info.plist has no keychain group")
        shared = try #require(KeychainGroups.shared, "Info.plist has no shared keychain group")
    }

    /// The app's own factory, on a test service.
    private func stores(_ name: String) throws -> (own: KeychainEventCredentialStore, shared: KeychainEventCredentialStore) {
        let stores = AppEnvironment.credentialStores(service: "moments.tests.handoff.\(name)")
        return (stores.own, try #require(stores.shared))
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

    @Test func theGroupsAreThisAppsAndTheSharedOne() throws {
        let appID = try #require(Bundle.main.bundleIdentifier)
        #expect(own.hasSuffix(".\(appID)") && own.count > appID.count + 1)
        #expect(shared == own + ".shared")
    }

    @Test func itemsSavedWithoutAGroupStayInTheAppsGroup() throws {
        // Host sessions are saved without a group: the first entitled group
        // (the app's) must be the default, never the one the Clip reads.
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
        let (ownStore, sharedStore) = try stores("fresh")
        defer { try? ownStore.removeAll(); try? sharedStore.removeAll() }
        let wedding = EventSlug("wedding")!
        try ownStore.save(joined("gt_old"), for: wedding)
        try sharedStore.save(joined("gt_clip"), for: party)
        let install = try freshInstall("fresh")
        defer { install.forget() }
        AppEnvironment.prepareCredentials(own: ownStore, shared: sharedStore, defaults: install.defaults)
        #expect(try ownStore.storedSlugs() == [party])
        #expect(try ownStore.credentials(for: party) == joined("gt_clip"))
        #expect(try sharedStore.storedSlugs().isEmpty)
    }

    @Test func laterLaunchesKeepTheAppsGuestsAndStillImport() throws {
        let (ownStore, sharedStore) = try stores("later")
        defer { try? ownStore.removeAll(); try? sharedStore.removeAll() }
        let install = try freshInstall("later")
        defer { install.forget() }
        let defaults = install.defaults
        AppEnvironment.prepareCredentials(own: ownStore, shared: sharedStore, defaults: defaults)
        let wedding = EventSlug("wedding")!
        try ownStore.save(joined("gt_app"), for: wedding)
        try sharedStore.save(joined("gt_clip"), for: party)
        AppEnvironment.prepareCredentials(own: ownStore, shared: sharedStore, defaults: defaults)
        #expect(try ownStore.storedSlugs() == [party, wedding])
        #expect(try sharedStore.storedSlugs().isEmpty)
    }

    @Test func withoutItsOwnGroupTheAppHandsNothingOver() {
        // A store without a group would span the shared one too: the import
        // would see the Clip's entry as the app's own and delete it.
        #expect(AppEnvironment.credentialStores(own: nil, shared: shared).shared == nil)
        #expect(AppEnvironment.credentialStores(own: own, shared: shared).shared != nil)
    }

    @Test func aHostSessionInTheSharedGroupIsNeitherLoadedNorOverwritten() throws {
        let service = "moments.tests.handoff.host"
        let planted = KeychainHostSessionStore(service: service, accessGroup: shared)
        let host = AppEnvironment.credentialStores(hostService: service).host
        defer { try? planted.remove(); try? host.remove() }
        let clipSession = StoredHostSession(token: "planted", expiresAt: .distantFuture)
        try planted.save(clipSession)
        #expect(try host.load() == nil)
        try host.save(StoredHostSession(token: "real", expiresAt: .distantFuture))
        #expect(try planted.load() == clipSession)
        #expect(try host.load()?.token == "real")
    }

    @Test(arguments: [
        ("7877JLKPRQ.com.moments-hq.moments", true),
        ("7877JLKPRQ.com.moments-hq.moments.shared", true),
        // An unsigned build: no team prefix.
        ("com.moments-hq.moments", false),
        ("$(AppIdentifierPrefix)com.moments-hq.moments", false),
        ("", false),
    ])
    func groupsNeedATeamPrefix(_ value: String, _ isValid: Bool) {
        #expect((KeychainGroups.group(value) != nil) == isValid)
    }

    @Test func aGroupThisAppIsntEntitledToIsRefused() throws {
        // Proves the simulator enforces access groups, so the tests above
        // check the entitlements and not just the logic.
        let store = KeychainEventCredentialStore(service: "moments.tests.handoff.foreign", accessGroup: own + ".other")
        defer { try? store.removeAll() }
        #expect(throws: (any Error).self) { try store.save(joined("gt"), for: party) }
    }
}
