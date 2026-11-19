import Foundation
import MomentsAPI
import MomentsDomain
import Observation

/// Why saving an event form didn't work.
public enum HostSaveFailure: Error, Equatable, Sendable {
    case offline
    case appTooOld
    /// Too many new events in a minute: wait a little.
    case rateLimited
    /// The server refused a field the form let through (e.g. a date that
    /// passed while the form was open).
    case refused
    /// The event was deleted meanwhile.
    case gone
    case failed
}

/// Where an event form is. Forms are one-shot: once saved (or signed out)
/// they refuse to save again; make a new one to edit again.
public enum HostSavePhase: Equatable, Sendable {
    case editing
    case saving
    /// Saved; the event as the server now has it.
    case saved(AdminEventDetail)
    case failed(HostSaveFailure)
    /// The session ended: the host screens clear themselves.
    case signedOut

    /// Whether `save()` may run: not while saving, not once done.
    var canSave: Bool {
        switch self {
        case .editing, .failed: true
        case .saving, .saved, .signedOut: false
        }
    }
}

/// The server's limits, counted the way it counts (UTF-16 code units).
public enum EventFieldLimits {
    public static let title = 120
    public static let type = 60
    public static let mainCharacters = 200
    public static let description = 1000
    public static let pinLength = 6...20
}

/// The create and edit forms' fields, with the checks the server makes.
public struct EventForm: Equatable, Sendable {
    public enum Problem: Hashable, Sendable {
        case titleMissing, titleTooLong
        case typeMissing, typeTooLong
        case mainCharactersTooLong
        case descriptionTooLong
        /// Creating only: an end that has passed would delete the new event.
        case endInPast
        case endBeforeStart
    }

    public var title = ""
    public var type = ""
    public var mainCharacters = ""
    public var description = ""
    public var startsAt: Date?
    /// Creating only: when uploads stop and the event is later deleted.
    public var endsAt: Date?

    public init() {}

    /// The edit form, filled with the event as it is.
    public init(event: Event) {
        title = event.title
        type = event.type
        mainCharacters = event.mainCharacters ?? ""
        description = event.description ?? ""
        startsAt = event.startsAt
    }

    public func problems(now: Date) -> Set<Problem> {
        var problems = Set<Problem>()
        let details = self.details
        if details.title.isEmpty { problems.insert(.titleMissing) }
        if details.title.utf16.count > EventFieldLimits.title { problems.insert(.titleTooLong) }
        if details.type.isEmpty { problems.insert(.typeMissing) }
        if details.type.utf16.count > EventFieldLimits.type { problems.insert(.typeTooLong) }
        if (details.mainCharacters?.utf16.count ?? 0) > EventFieldLimits.mainCharacters { problems.insert(.mainCharactersTooLong) }
        if (details.description?.utf16.count ?? 0) > EventFieldLimits.description { problems.insert(.descriptionTooLong) }
        if let endsAt {
            if endsAt <= now { problems.insert(.endInPast) }
            if let startsAt, endsAt < startsAt { problems.insert(.endBeforeStart) }
        }
        return problems
    }

    /// Trimmed, as the server stores it; empty optional text is none.
    public var details: EventDetails {
        EventDetails(
            title: Self.trimmed(title), type: Self.trimmed(type),
            mainCharacters: Self.trimmedOrNil(mainCharacters), description: Self.trimmedOrNil(description),
            startsAt: startsAt
        )
    }

    /// JS `trim()` also strips U+FEFF; match it so the server never sees a blank title.
    static let trimmedCharacters = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}"))

    private static func trimmed(_ text: String) -> String { text.trimmingCharacters(in: trimmedCharacters) }
    private static func trimmedOrNil(_ text: String) -> String? {
        let value = trimmed(text)
        return value.isEmpty ? nil : value
    }
}

/// Creates an event, or edits one's title, type, people, description and date.
@MainActor @Observable
public final class HostEventFormModel {
    public var form: EventForm
    /// Nil when creating.
    public let eventID: String?
    public private(set) var phase: HostSavePhase = .editing
    /// A create failed in a way that doesn't tell whether the server made
    /// the event (offline mid-call, a server error): the screen should
    /// suggest checking the events list before saving again.
    public private(set) var mayHaveCreated = false

    @ObservationIgnored private let initialDetails: EventDetails
    @ObservationIgnored private let service: any HostService
    @ObservationIgnored private let account: HostAccount

    /// A new event's form.
    public init(service: any HostService, account: HostAccount) {
        form = EventForm()
        initialDetails = EventForm().details
        eventID = nil
        self.service = service
        self.account = account
    }

    /// The form to edit `event`.
    public init(editing event: Event, service: any HostService, account: HostAccount) {
        form = EventForm(event: event)
        initialDetails = EventForm(event: event).details
        eventID = event.id
        self.service = service
        self.account = account
    }

    public func problems(now: Date = .now) -> Set<EventForm.Problem> { form.problems(now: now) }

    /// Whether the details differ from how the form started, as the server
    /// would store them (spaces at the ends don't count).
    public var hasChanges: Bool { form.details != initialDetails || form.endsAt != nil }

    public func save(now: Date = .now) async {
        guard phase.canSave, form.problems(now: now).isEmpty else { return }
        let details = form.details
        phase = .saving
        if let eventID {
            phase = await saveHostEvent(account, logCategory: "host-event-edit") { [service] token in
                try await service.updateEvent(token: token, id: eventID, details: details)
            }
        } else {
            let endsAt = form.endsAt
            // Never sent twice: a repeat would create a second event.
            phase = await saveHostEvent(account, logCategory: "host-event-create", isRepeatable: false) { [service] token in
                try await service.createEvent(token: token, details: details, endsAt: endsAt)
            }
            if case .failed(.offline) = phase { mayHaveCreated = true }
            if case .failed(.failed) = phase { mayHaveCreated = true }
        }
    }

    /// Back to editing after a failure was shown.
    public func dismissFailure() {
        if case .failed = phase { phase = .editing }
    }
}

/// Makes an event public or private, optionally with a new PIN.
@MainActor @Observable
public final class HostEventAccessModel {
    public enum Problem: Hashable, Sendable {
        /// Going private needs a PIN guests can type.
        case pinRequired
        case pinTooShort, pinTooLong
    }

    public var mode: Event.AccessMode
    /// Empty keeps the current PIN.
    public var newPIN = ""
    public let eventID: String
    public private(set) var phase: HostSavePhase = .editing

    @ObservationIgnored private let currentMode: Event.AccessMode
    @ObservationIgnored private let service: any HostService
    @ObservationIgnored private let account: HostAccount

    public init(event: Event, service: any HostService, account: HostAccount) {
        mode = event.accessMode
        currentMode = event.accessMode
        eventID = event.id
        self.service = service
        self.account = account
    }

    private var trimmedPIN: String { newPIN.trimmingCharacters(in: EventForm.trimmedCharacters) }
    /// The PIN that saving would send: none for a public event, whatever
    /// the field holds.
    private var sentPIN: String { mode == .private ? trimmedPIN : "" }

    /// An already-private event keeps its PIN when none is typed.
    public var keepsCurrentPIN: Bool { currentMode == .private }

    public var problems: Set<Problem> {
        let pin = sentPIN
        var problems = Set<Problem>()
        if !pin.isEmpty, pin.utf16.count < EventFieldLimits.pinLength.lowerBound { problems.insert(.pinTooShort) }
        if pin.utf16.count > EventFieldLimits.pinLength.upperBound { problems.insert(.pinTooLong) }
        // A public event may still hold an old PIN; asking for a fresh one is clearer.
        if pin.isEmpty, mode == .private, currentMode != .private { problems.insert(.pinRequired) }
        return problems
    }

    /// Whether saving signs every guest out (and replaces the invite link
    /// when the PIN changes), so the screen can say so first.
    public var signsGuestsOut: Bool {
        !sentPIN.isEmpty || (mode == .private && currentMode != .private)
    }

    public var hasChanges: Bool { mode != currentMode || !sentPIN.isEmpty }

    public func save() async {
        guard phase.canSave, hasChanges, problems.isEmpty else { return }
        let (id, mode, pin) = (eventID, mode, sentPIN.isEmpty ? nil : sentPIN)
        phase = .saving
        phase = await saveHostEvent(account, logCategory: "host-event-access") { [service] token in
            try await service.updateAccess(token: token, id: id, mode: mode, newPIN: pin)
        }
        // The PIN is never kept once it has been sent, nor once this form
        // can't be used any more. A plain failure keeps it for a retry, and
        // a different one typed meanwhile is the host's, not ours to clear.
        let isDone = switch phase {
        case .saved, .signedOut, .failed(.gone): true
        default: false
        }
        if isDone, trimmedPIN == (pin ?? "") { newPIN = "" }
    }

    /// Back to editing after a failure, except a deleted event: nothing
    /// typed can fix that, so its message stays.
    public func dismissFailure() {
        if case let .failed(failure) = phase, failure != .gone { phase = .editing }
    }
}

/// When an event's uploads close and when it is deleted.
@MainActor @Observable
public final class HostEventDatesModel {
    public enum Problem: Hashable, Sendable {
        /// The next cleanup would delete the event.
        case deleteInPast
        case closeAfterDelete
    }

    /// Nil: uploads stay open. A past date closes them now.
    public var uploadsCloseAt: Date?
    /// Nil: never deleted.
    public var deleteAfter: Date?
    public let eventID: String
    public private(set) var phase: HostSavePhase = .editing

    @ObservationIgnored private let initialDates: (close: Date?, delete: Date?)
    @ObservationIgnored private let service: any HostService
    @ObservationIgnored private let account: HostAccount

    public init(event: Event, service: any HostService, account: HostAccount) {
        uploadsCloseAt = event.effectiveUploadsCloseAt
        deleteAfter = event.effectivePurgeAfter
        initialDates = (event.effectiveUploadsCloseAt, event.effectivePurgeAfter)
        eventID = event.id
        self.service = service
        self.account = account
    }

    public func problems(now: Date = .now) -> Set<Problem> {
        var problems = Set<Problem>()
        if let deleteAfter {
            if deleteAfter <= now { problems.insert(.deleteInPast) }
            if let uploadsCloseAt, uploadsCloseAt > deleteAfter { problems.insert(.closeAfterDelete) }
        }
        return problems
    }

    /// Saving also un-archives the event (the server always does), so an
    /// untouched form never saves.
    public var hasChanges: Bool { uploadsCloseAt != initialDates.close || deleteAfter != initialDates.delete }

    public func save(now: Date = .now) async {
        guard phase.canSave, hasChanges, problems(now: now).isEmpty else { return }
        let (id, close, delete) = (eventID, uploadsCloseAt, deleteAfter)
        phase = .saving
        phase = await saveHostEvent(account, logCategory: "host-event-dates") { [service] token in
            try await service.updateDates(token: token, id: id, uploadsCloseAt: close, deleteAfter: delete)
        }
    }

    public func dismissFailure() {
        if case .failed = phase { phase = .editing }
    }
}

/// One save through the host session, with the refusals a form can show.
@MainActor
private func saveHostEvent(
    _ account: HostAccount,
    logCategory: String,
    isRepeatable: Bool = true,
    _ call: @escaping (String) async throws -> AdminEventDetail
) async -> HostSavePhase {
    let outcome = await account.run(logCategory: logCategory, notFound: .eventNotFound, isRepeatable: isRepeatable) { token in
        do {
            return Result<AdminEventDetail, HostSaveFailure>.success(try await call(token))
        } catch MomentsAPIError.rateLimited {
            return .failure(.rateLimited)
        } catch MomentsAPIError.invalidRequest {
            return .failure(.refused)
        }
    }
    switch outcome {
    case let .success(.success(detail)): return .saved(detail)
    case let .success(.failure(failure)): return .failed(failure)
    case .notFound: return .failed(.gone)
    case .signedOut: return .signedOut
    case .cancelled: return .editing
    case let .failure(failure):
        switch failure {
        case .offline: return .failed(.offline)
        case .appTooOld: return .failed(.appTooOld)
        case .failed: return .failed(.failed)
        }
    }
}
