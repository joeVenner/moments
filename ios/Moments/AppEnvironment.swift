import CredentialStore
import CryptoKit
import FeatureGuest
import Foundation
import MomentsAPI
import OSLog

/// App-wide dependencies, built once at launch.
@MainActor
struct AppEnvironment {
    let service: any MomentsService
    let credentials: any EventCredentialStore
    let guest: GuestDependencies

    static let productionBaseURL = URL(string: "https://moments-hq.com")!

    /// Debug builds can point at `npm run dev` with the scheme's
    /// `MOMENTS_API_BASE_URL` (localhost only; credentials go there).
    static var baseURL: URL {
        #if DEBUG
        if let override = ProcessInfo.processInfo.environment["MOMENTS_API_BASE_URL"],
           let url = URL(string: override), ["localhost", "127.0.0.1"].contains(url.host()) {
            return url
        }
        #endif
        return productionBaseURL
    }

    static func live() -> AppEnvironment {
        let credentials = KeychainEventCredentialStore()
        do {
            try CredentialLifecycle.resetIfFreshInstall(credentials)
        } catch {
            // Status only; never the item contents.
            Logger(subsystem: "moments", category: "credentials").error("fresh-install reset failed: \(String(describing: error), privacy: .public)")
        }
        // Before any screen can open the photo picker: picked originals
        // (with their location data) left by an earlier run go.
        GuestUploadsLaunch.clearLeftovers()
        return make(credentials: credentials, defaults: .standard)
    }

    /// For tests and previews: no keychain, no network calls until used.
    static func inMemory() -> AppEnvironment {
        // A throwaway defaults domain, so tests leave nothing behind.
        let suite = "moments.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite) ?? .standard
        defaults.removePersistentDomain(forName: suite)
        return make(credentials: InMemoryEventCredentialStore(), defaults: defaults)
    }

    private static func make(credentials: any EventCredentialStore, defaults: UserDefaults) -> AppEnvironment {
        let client = makeClient()
        let guest = GuestDependencies(
            service: client, store: credentials, mediaFetcher: makeMediaFetcher(),
            reactorID: reactorIDs(secret: reactorSecret(defaults))
        )
        return AppEnvironment(service: client, credentials: credentials, guest: guest)
    }

    /// Random per install; never sent. Reactor ids are derived from it.
    static func reactorSecret(_ defaults: UserDefaults) -> Data {
        let key = "moments.reactor-secret"
        if let existing = defaults.data(forKey: key), existing.count == 32 { return existing }
        let secret = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        defaults.set(secret, forKey: key)
        return secret
    }

    /// The web's reactor id marks which reactions a device made. Here it is
    /// derived per event (HMAC of the event id), so the server can't link
    /// one device across events. Stable for the install.
    static func reactorIDs(secret: Data) -> @Sendable (String) -> String {
        let key = SymmetricKey(data: secret)
        return { eventID in
            let mac = HMAC<SHA256>.authenticationCode(for: Data(eventID.utf8), using: key)
            return mac.prefix(16).map { String(format: "%02x", $0) }.joined()
        }
    }

    private static func makeMediaFetcher() -> MediaFetcher {
        if let fetcher = try? MediaFetcher(baseURL: baseURL, identity: .fromBundle()) { return fetcher }
        guard let fetcher = try? MediaFetcher(baseURL: productionBaseURL, identity: .fromBundle()) else {
            fatalError("the production base URL must be accepted")
        }
        return fetcher
    }

    private static func makeClient() -> MomentsClient {
        if let client = try? MomentsClient(baseURL: baseURL, identity: .fromBundle()) { return client }
        // Only a malformed debug override gets here.
        guard let client = try? MomentsClient(baseURL: productionBaseURL, identity: .fromBundle()) else {
            fatalError("the production base URL must be accepted")
        }
        return client
    }
}
