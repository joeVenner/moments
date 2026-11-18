import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import UploadEngine

/// What the upload screen needs: where prepared files go, and the queue.
public struct UploadDependencies: Sendable {
    public let staging: StagingArea
    public let submitter: any UploadSubmitting
    public let importer: any MediaImporting
    /// The queue's state for the "Your uploads" screen; nil hides it.
    public let progress: (any UploadProgressSource)?

    public init(
        staging: StagingArea, submitter: any UploadSubmitting, importer: any MediaImporting = LiveMediaImporter(),
        progress: (any UploadProgressSource)? = nil
    ) {
        self.staging = staging
        self.submitter = submitter
        self.importer = importer
        self.progress = progress
    }
}

/// What the guest screens need from the app, injected once.
public struct GuestDependencies: Sendable {
    public let service: any MomentsService
    public let store: any EventCredentialStore
    public let mediaFetcher: MediaFetcher
    /// Marks this device's reactions in one event (like the web's reactor
    /// id), derived per event so events can't be linked to one device.
    public let reactorID: @Sendable (_ eventID: String) -> String
    /// Nil until uploads are wired in the app: the share button is hidden.
    public let uploads: UploadDependencies?
    /// "Leave this event"; nil hides it.
    public let leaver: (any LeaveService)?

    public init(
        service: any MomentsService, store: any EventCredentialStore, mediaFetcher: MediaFetcher,
        reactorID: @escaping @Sendable (_ eventID: String) -> String, uploads: UploadDependencies? = nil,
        leaver: (any LeaveService)? = nil
    ) {
        self.uploads = uploads
        self.leaver = leaver
        self.service = service
        self.store = store
        self.mediaFetcher = mediaFetcher
        self.reactorID = reactorID
    }
}
