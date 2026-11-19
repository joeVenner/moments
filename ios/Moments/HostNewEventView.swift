import DesignSystem
import FeatureHost
import MomentsAPI
import MomentsDomain
import SwiftUI

/// The "New event" sheet: title, type, who it's about, a description and
/// optional dates. New events start public and open for uploads.
struct HostNewEventView: View {
    @State private var model: HostEventFormModel
    let onCreated: (AdminEventDetail) -> Void
    let onCancel: () -> Void

    init(host: HomeView.Host, onCreated: @escaping (AdminEventDetail) -> Void, onCancel: @escaping () -> Void) {
        self.init(model: HostEventFormModel(service: host.service, account: host.account), onCreated: onCreated, onCancel: onCancel)
    }

    /// With a prepared model (screenshot tests).
    init(model: HostEventFormModel, onCreated: @escaping (AdminEventDetail) -> Void, onCancel: @escaping () -> Void) {
        _model = State(initialValue: model)
        self.onCreated = onCreated
        self.onCancel = onCancel
    }

    var body: some View {
        sheet
            .onChange(of: model.form) { model.dismissFailure() }
            .onChange(of: model.phase) {
                switch model.phase {
                case let .saved(detail): onCreated(detail)
                case .signedOut: onCancel()
                case .editing, .saving, .failed: break
                }
            }
    }

    var sheet: HostFormSheet<some View> {
        HostFormSheet(
            title: "New event",
            // After an unclear failure the event may exist: say so on the button.
            saveTitle: model.mayHaveCreated ? "Create anyway" : "Create event",
            savingLabel: "Creating the event",
            messages: HostEventFormText.messages(for: model.problems()),
            failure: failure,
            canSave: model.problems().isEmpty,
            isSaving: model.phase == .saving,
            onSave: { Task { await model.save() } },
            onCancel: onCancel
        ) {
            HostEventDetailsFields(form: $model.form, focusesTitle: true)
            HostOptionalDate(
                label: "End date",
                hint: "Guests can share until then. The event and its photos and videos are deleted afterwards.",
                date: $model.form.endsAt,
                defaultDate: { HostEventFormText.nextHour(after: model.form.startsAt ?? .now, addingDays: 7) }
            )
        }
    }

    private var failure: String? {
        // Stays after the host edits the form: the event may exist.
        if model.mayHaveCreated { return Self.message(for: .failed, mayHaveCreated: true) }
        guard case let .failed(failure) = model.phase else { return nil }
        return Self.message(for: failure, mayHaveCreated: false)
    }

    static func message(for failure: HostSaveFailure, mayHaveCreated: Bool) -> String {
        switch failure {
        case .offline where mayHaveCreated, .failed where mayHaveCreated:
            String(localized: "We couldn't tell whether the event was created. Check your events before trying again.")
        case .offline: String(localized: "You're offline. Try again when you're connected.")
        case .appTooOld: String(localized: "Update Moments to create events.")
        case .rateLimited: String(localized: "You've created a lot of events just now. Wait a minute and try again.")
        case .refused: String(localized: "The event couldn't be created with these details. Check the dates and try again.")
        case .gone, .failed: String(localized: "The event couldn't be created. Try again.")
        }
    }
}
