import DesignSystem
import FeatureHost
import MomentsAPI
import MomentsDomain
import SwiftUI

/// Which edit sheet the event detail shows.
enum HostEventEdit: String, Identifiable {
    case details, dates
    var id: String { rawValue }
}

/// Edits an event's title, type, people, description and date. Its link
/// never changes, so shared QR codes keep working.
struct HostEditDetailsView: View {
    @State private var model: HostEventFormModel
    /// Called once the sheet should close: with the saved event, or nil
    /// (cancelled, signed out).
    let onDone: (AdminEventDetail?) -> Void

    init(event: Event, host: HomeView.Host, onDone: @escaping (AdminEventDetail?) -> Void) {
        self.init(model: HostEventFormModel(editing: event, service: host.service, account: host.account), onDone: onDone)
    }

    /// With a prepared model (screenshot tests).
    init(model: HostEventFormModel, onDone: @escaping (AdminEventDetail?) -> Void) {
        _model = State(initialValue: model)
        self.onDone = onDone
    }

    var body: some View {
        sheet
            .onChange(of: model.form) { model.dismissFailure() }
            .onChange(of: model.phase) { if model.phase.isDone { onDone(model.phase.savedDetail) } }
    }

    var sheet: HostFormSheet<some View> {
        HostFormSheet(
            title: "Edit details",
            saveTitle: "Save",
            savingLabel: "Saving",
            messages: HostEventFormText.messages(for: model.problems()),
            failure: failure,
            canSave: model.hasChanges && model.problems().isEmpty,
            isSaving: model.phase == .saving,
            onSave: { Task { await model.save() } },
            onCancel: { onDone(nil) }
        ) {
            HostEventDetailsFields(form: $model.form, focusesTitle: false)
            Text("The event's link and QR code stay the same.")
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var failure: String? {
        guard case let .failed(failure) = model.phase else { return nil }
        return HostEventFormText.editMessage(for: failure)
    }
}

/// When guests can no longer share, and when the event is deleted.
struct HostEditDatesView: View {
    @State private var model: HostEventDatesModel
    let onDone: (AdminEventDetail?) -> Void

    init(event: Event, host: HomeView.Host, onDone: @escaping (AdminEventDetail?) -> Void) {
        self.init(model: HostEventDatesModel(event: event, service: host.service, account: host.account), onDone: onDone)
    }

    /// With a prepared model (screenshot tests).
    init(model: HostEventDatesModel, onDone: @escaping (AdminEventDetail?) -> Void) {
        _model = State(initialValue: model)
        self.onDone = onDone
    }

    var body: some View {
        sheet
            .onChange(of: model.uploadsCloseAt) { model.dismissFailure() }
            .onChange(of: model.deleteAfter) { model.dismissFailure() }
            .onChange(of: model.phase) { if model.phase.isDone { onDone(model.phase.savedDetail) } }
    }

    var sheet: HostFormSheet<some View> {
        HostFormSheet(
            title: "Dates",
            saveTitle: "Save",
            savingLabel: "Saving",
            messages: HostEventFormText.messages(for: model.problems()),
            failure: failure,
            canSave: model.hasChanges && model.problems().isEmpty,
            isSaving: model.phase == .saving,
            onSave: { Task { await model.save() } },
            onCancel: { onDone(nil) }
        ) {
            HostOptionalDate(
                label: "Uploads close",
                hint: "Guests can share until then. A date that has passed closes uploads now.",
                date: $model.uploadsCloseAt,
                defaultDate: { HostEventFormText.nextHour(after: .now, addingDays: 1) }
            )
            HostOptionalDate(
                label: "Delete the event",
                hint: "The event and its photos and videos are deleted on this date. Off keeps them.",
                date: $model.deleteAfter,
                // Never from a close date that has passed: that default would already be due.
                defaultDate: { HostEventFormText.nextHour(after: max(.now, model.uploadsCloseAt ?? .now), addingDays: 30) }
            )
        }
    }

    private var failure: String? {
        guard case let .failed(failure) = model.phase else { return nil }
        return HostEventFormText.editMessage(for: failure)
    }
}

extension HostSavePhase {
    /// Whether an edit sheet should close: saved, or the session ended.
    var isDone: Bool {
        switch self {
        case .saved, .signedOut: true
        case .editing, .saving, .failed: false
        }
    }

    /// The event as saved, once saved.
    var savedDetail: AdminEventDetail? {
        if case let .saved(detail) = self { detail } else { nil }
    }
}
