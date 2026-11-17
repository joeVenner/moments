import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain

/// What the guest screens need from the app, injected once.
public struct GuestDependencies: Sendable {
    public let service: any MomentsService
    public let store: any EventCredentialStore
    public let mediaFetcher: MediaFetcher
    /// Marks this device's reactions in one event (like the web's reactor
    /// id), derived per event so events can't be linked to one device.
    public let reactorID: @Sendable (_ eventID: String) -> String

    public init(
        service: any MomentsService, store: any EventCredentialStore, mediaFetcher: MediaFetcher,
        reactorID: @escaping @Sendable (_ eventID: String) -> String
    ) {
        self.service = service
        self.store = store
        self.mediaFetcher = mediaFetcher
        self.reactorID = reactorID
    }
}
