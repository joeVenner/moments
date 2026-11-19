import DesignSystem
import FeatureHost
import MomentsAPI
import MomentsDomain
import SwiftUI

/// Which edit sheet the event detail shows.
enum HostEventEdit: String, Identifiable {
    case details, privacy, dates
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

/// Public or private, and the PIN. Saving a new PIN or going private signs
/// every guest out, so that is confirmed once first.
struct HostEditPrivacyView: View {
    @State private var model: HostEventAccessModel
    @State private var isConfirming = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let onDone: (AdminEventDetail?) -> Void

    init(event: Event, host: HomeView.Host, onDone: @escaping (AdminEventDetail?) -> Void) {
        self.init(model: HostEventAccessModel(event: event, service: host.service, account: host.account), onDone: onDone)
    }

    /// With a prepared model (screenshot tests).
    init(model: HostEventAccessModel, onDone: @escaping (AdminEventDetail?) -> Void) {
        _model = State(initialValue: model)
        self.onDone = onDone
    }

    var body: some View {
        sheet
            .onChange(of: model.mode) {
                model.dismissFailure()
                // A hidden field must not send a PIN with a public event.
                if model.mode == .public { model.newPIN = "" }
            }
            .onChange(of: model.newPIN) { model.dismissFailure() }
            .onChange(of: model.phase) { if model.phase.isDone { onDone(model.phase.savedDetail) } }
            // The PIN never outlives the sheet.
            .onDisappear { model.newPIN = "" }
            .confirmationDialog(
                Text("Sign everyone out?"),
                isPresented: $isConfirming,
                titleVisibility: .visible
            ) {
                Button("Save and sign guests out", role: .destructive) { Task { await model.save() } }
            } message: {
                Text("Everyone will need the new PIN or invite link. Guests already in are signed out, and the old invite link stops working.")
            }
    }

    var sheet: HostFormSheet<some View> {
        HostFormSheet(
            title: "Privacy",
            saveTitle: "Save",
            savingLabel: "Saving",
            messages: Self.messages(for: model.problems),
            failure: failure,
            canSave: model.hasChanges && model.problems.isEmpty,
            isSaving: model.phase == .saving,
            onSave: save,
            onCancel: { onDone(nil) }
        ) {
            Picker(selection: $model.mode) {
                Text("Public").tag(Event.AccessMode.public)
                Text("Private").tag(Event.AccessMode.private)
            } label: {
                Text("Who can join")
            }
            // Segments clip at accessibility sizes; a menu wraps.
            .modifier(AccessPickerStyle(isMenu: dynamicTypeSize.isAccessibilitySize))
            .tint(MomentsColor.accent)
            .disabled(model.phase == .saving)
            Text(model.mode == .private
                ? "Guests need the PIN or the invite link to open the event."
                : "Anyone with the event link or QR code can open the event.")
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            if model.mode == .private {
                HostPINField(pin: $model.newPIN, keepsCurrentPIN: model.keepsCurrentPIN)
                    .disabled(model.phase == .saving)
            }
        }
    }

    private func save() {
        if model.signsGuestsOut { isConfirming = true } else { Task { await model.save() } }
    }

    private var failure: String? {
        guard case let .failed(failure) = model.phase else { return nil }
        // The server refuses a PIN, not dates, on this form. A failed save
        // keeps the PIN, so the field says whether one was sent.
        if failure == .refused {
            return model.newPIN.isEmpty
                ? String(localized: "These changes couldn't be saved. Try again.")
                : String(localized: "This PIN couldn't be saved. Try another one.")
        }
        return HostEventFormText.editMessage(for: failure)
    }

    /// What's wrong with the PIN. Never the PIN itself: these are announced.
    static func messages(for problems: Set<HostEventAccessModel.Problem>) -> [String] {
        var messages: [String] = []
        if problems.contains(.pinRequired) { messages.append(String(localized: "Choose a PIN to make the event private.")) }
        if problems.contains(.pinTooShort) || problems.contains(.pinTooLong) {
            let range = EventFieldLimits.pinLength
            messages.append(String(localized: "The PIN must be \(range.lowerBound) to \(range.upperBound) characters."))
        }
        return messages
    }
}

/// The new PIN: hidden as typed, never suggested, saved or autocorrected.
struct HostPINField: View {
    @Binding var pin: String
    /// An already-private event keeps its PIN when this is left empty.
    let keepsCurrentPIN: Bool

    var body: some View {
        HostFormField(label: "New PIN") {
            SecureField(text: $pin, prompt: prompt.foregroundStyle(MomentsColor.textMuted)) {
                Text("New PIN")
            }
            .textContentType(nil)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .momentsField()
        }
    }

    private var prompt: Text {
        let range = EventFieldLimits.pinLength
        return keepsCurrentPIN
            ? Text("Leave empty to keep the current PIN")
            : Text("\(range.lowerBound) to \(range.upperBound) characters")
    }
}

/// The public/private picker: segments, or a menu at accessibility sizes.
private struct AccessPickerStyle: ViewModifier {
    let isMenu: Bool

    func body(content: Content) -> some View {
        if isMenu {
            content.pickerStyle(.menu)
        } else {
            content.pickerStyle(.segmented)
        }
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
