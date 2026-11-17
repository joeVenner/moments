import CredentialStore
import Foundation
import MomentsAPI
import OSLog

/// App-wide dependencies, built once at launch.
@MainActor
struct AppEnvironment {
    let service: any MomentsService
    let credentials: any EventCredentialStore

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
        return AppEnvironment(service: makeClient(), credentials: credentials)
    }

    /// For tests and previews: no keychain, no network calls until used.
    static func inMemory() -> AppEnvironment {
        AppEnvironment(service: makeClient(), credentials: InMemoryEventCredentialStore())
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
