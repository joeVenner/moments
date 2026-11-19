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
    /// Closes an event's uploads while the guest leaves it; nil: none.
    public let leaving: LeavingUploads?

    public init(
        staging: StagingArea, submitter: any UploadSubmitting, importer: any MediaImporting = LiveMediaImporter(),
        progress: (any UploadProgressSource)? = nil,
        leaving: LeavingUploads? = nil
    ) {
        self.staging = staging
        self.submitter = submitter
        self.importer = importer
        self.progress = progress
        self.leaving = leaving
    }
}

/// What leaving an event does to its uploads: `begin` drops them and keeps
/// the event closed to uploads until `end`, whether the leave worked or not.
public struct LeavingUploads: Sendable {
    public let begin: @Sendable (_ eventSlug: String) async -> Void
    public let end: @Sendable (_ eventSlug: String) async -> Void

    public init(
        begin: @escaping @Sendable (_ eventSlug: String) async -> Void,
        end: @escaping @Sendable (_ eventSlug: String) async -> Void
    ) {
        self.begin = begin
        self.end = end
    }

    public init(queue: UploadQueue) {
        begin = { await queue.beginLeaving(eventSlug: $0) }
        end = { await queue.endLeaving(eventSlug: $0) }
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
