import Foundation
import MomentsAPI

enum ClipClient {
    static let productionBaseURL = URL(string: "https://moments-hq.com")!

    /// Debug builds can point at `npm run dev` with the scheme's
    /// `MOMENTS_API_BASE_URL` (localhost only), like the app.
    static var baseURL: URL {
        #if DEBUG
        if let override = ProcessInfo.processInfo.environment["MOMENTS_API_BASE_URL"],
           let url = URL(string: override), ["localhost", "127.0.0.1"].contains(url.host()) {
            return url
        }
        #endif
        return productionBaseURL
    }

    static func make() -> MomentsClient {
        if let client = try? MomentsClient(baseURL: baseURL, identity: .fromBundle()) { return client }
        guard let client = try? MomentsClient(baseURL: productionBaseURL, identity: .fromBundle()) else {
            fatalError("the production base URL must be accepted")
        }
        return client
    }
}
