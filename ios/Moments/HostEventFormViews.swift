import DesignSystem
import FeatureHost
import MomentsDomain
import SwiftUI
import UIKit

/// The frame every event form shares: a title, the fields, what's wrong,
/// then Save and Cancel. Each form keeps its own model and phase handling.
struct HostFormSheet<Fields: View>: View {
    let title: LocalizedStringKey
    let saveTitle: LocalizedStringKey
    let savingLabel: LocalizedStringKey
    /// What's wrong with the fields, already worded.
    let messages: [String]
    /// Why the last save didn't work, if it didn't.
    let failure: String?
    let canSave: Bool
    let isSaving: Bool
    let onSave: () -> Void
    let onCancel: () -> Void
    @ViewBuilder let fields: Fields

    var body: some View {
        ScrollView { form }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(MomentsColor.background.ignoresSafeArea())
            // Half-way through saving, the sheet stays until the answer.
            .interactiveDismissDisabled(isSaving)
            .privacyShielded()
    }

    /// The form without its scroll view (also rendered by screenshot tests).
    var form: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text(title)
                .font(MomentsFont.display(.title2))
                .foregroundStyle(MomentsColor.text)
                .accessibilityAddTraits(.isHeader)
                .fixedSize(horizontal: false, vertical: true)
            fields
            ForEach(messages + [failure].compactMap { $0 }, id: \.self) { message in
                Text(message)
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.accent)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button {
                // The keyboard would hide the answer.
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                onSave()
            } label: {
                if isSaving {
                    ProgressView().tint(MomentsColor.text)
                        .accessibilityLabel(Text(savingLabel))
                } else {
                    Text(saveTitle)
                }
            }
            .buttonStyle(.momentsPrimary)
            .disabled(!canSave || isSaving)
            Button("Cancel", action: onCancel)
                .buttonStyle(.momentsSecondary)
                .disabled(isSaving)
        }
        .padding(Spacing.lg)
        .onChange(of: messages) { old, new in
            guard let added = new.first(where: { !old.contains($0) }) else { return }
            AccessibilityNotification.Announcement(added).post()
        }
        // Every save that ends in a failure is announced, even one that
        // fails the same way as the last.
        .onChange(of: isSaving) { wasSaving, isSaving in
            guard wasSaving, !isSaving, let failure else { return }
            AccessibilityNotification.Announcement(failure).post()
        }
    }
}

/// Title, type, who it's about, description and the event date: shared by
/// the New event and Edit details forms.
struct HostEventDetailsFields: View {
    @Binding var form: EventForm
    /// New forms start typing in the title; edit forms leave focus alone.
    let focusesTitle: Bool

    @FocusState private var focus: Field?
    private enum Field { case title, type, people, description }
    /// "Other" is chosen: the type is typed in. Starts on for an event whose
    /// stored type is a custom one. Read once: both sheets build these fields
    /// afresh each time they open.
    @State private var isOtherType: Bool

    init(form: Binding<EventForm>, focusesTitle: Bool) {
        _form = form
        self.focusesTitle = focusesTitle
        _isOtherType = State(initialValue: EventTypePreset.isCustom(form.wrappedValue.type))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            HostFormField(label: "Title") {
                TextField(text: $form.title, prompt: prompt("Sara & Omar's wedding")) { Text("Title") }
                    .focused($focus, equals: .title)
                    .submitLabel(.next)
                    .onSubmit { focus = isOtherType ? .type : .people }
                    .momentsField()
            }
            HostFormField(label: "Type") {
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    HostEventTypeChips(selection: selectedChip, onSelect: select)
                    if isOtherType {
                        TextField(text: $form.type, prompt: prompt("Baby shower, reunion…")) { Text("Type") }
                            .focused($focus, equals: .type)
                            .submitLabel(.next)
                            .onSubmit { focus = .people }
                            .momentsField()
                    }
                }
            }
            HostFormField(label: "Who it's about (optional)") {
                TextField(text: $form.mainCharacters, prompt: prompt("Sara & Omar")) { Text("Who it's about") }
                    .focused($focus, equals: .people)
                    .submitLabel(.next)
                    .onSubmit { focus = .description }
                    .momentsField()
            }
            HostFormField(label: "Description (optional)") {
                TextField(text: $form.description, prompt: prompt("Shown to guests under the title"), axis: .vertical) {
                    Text("Description")
                }
                .lineLimit(3...6)
                .focused($focus, equals: .description)
                .padding(.vertical, Spacing.xs)
                .momentsField()
            }
            HostOptionalDate(
                label: "Event date",
                hint: nil,
                date: $form.startsAt,
                defaultDate: { HostEventFormText.nextHour(after: .now, addingDays: 1) }
            )
        }
        .onAppear { if focusesTitle { focus = .title } }
        // Focuses the field once it exists (it appears with Other).
        .onChange(of: isOtherType) { if isOtherType { focus = .type } }
    }

    /// The lit chip: Other while typing a custom type, else the preset the
    /// type matches (none for a new, empty form).
    private var selectedChip: HostEventTypeChips.Choice? {
        if isOtherType { return .other }
        return EventTypePreset.matching(form.type).map(HostEventTypeChips.Choice.preset)
    }

    private func select(_ choice: HostEventTypeChips.Choice) {
        switch choice {
        case let .preset(preset):
            isOtherType = false
            // Keeps a stored "wedding" as is, so re-tapping isn't an edit.
            if EventTypePreset.matching(form.type) != preset { form.type = preset.storedValue }
        case .other:
            isOtherType = true
            // A preset's word would only need deleting.
            if EventTypePreset.matching(form.type) != nil { form.type = "" }
        }
    }

    private func prompt(_ text: LocalizedStringKey) -> Text {
        Text(text).foregroundStyle(MomentsColor.textMuted)
    }
}

/// One-tap event types, then Other for anything else.
struct HostEventTypeChips: View {
    enum Choice: Hashable {
        case preset(EventTypePreset)
        case other
    }

    let selection: Choice?
    let onSelect: (Choice) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: Spacing.xs) {
            ForEach(EventTypePreset.allCases) { preset in
                chip(.preset(preset), title: Self.title(for: preset))
            }
            chip(.other, title: "Other")
                .accessibilityHint(Text("Type your own"))
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Type"))
    }

    private var columns: [GridItem] {
        typeSize.isAccessibilitySize
            ? [GridItem(.flexible())]
            : [GridItem(.adaptive(minimum: 112), spacing: Spacing.xs)]
    }

    private func chip(_ choice: Choice, title: LocalizedStringKey) -> some View {
        let isSelected = selection == choice
        return Button { onSelect(choice) } label: {
            Text(title)
                .font(MomentsFont.body())
                .fontWeight(isSelected ? .semibold : .regular)
                .foregroundStyle(isSelected ? MomentsColor.onAccent : MomentsColor.text)
                .padding(.horizontal, Spacing.sm)
                .frame(maxWidth: .infinity, minHeight: Radius.minimumTapTarget)
                .background(isSelected ? MomentsColor.accent : MomentsColor.surface, in: Capsule())
                .overlay(Capsule().stroke(isSelected ? MomentsColor.accent : MomentsColor.border))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    static func title(for preset: EventTypePreset) -> LocalizedStringKey {
        switch preset {
        case .wedding: "Wedding"
        case .birthday: "Birthday"
        case .graduation: "Graduation"
        case .corporate: "Corporate"
        case .party: "Party"
        }
    }
}

/// A label over one form control.
struct HostFormField<Content: View>: View {
    let label: LocalizedStringKey
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(label)
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            content
        }
    }
}

/// A date that's either off or set: a toggle, then the picker.
struct HostOptionalDate: View {
    let label: LocalizedStringKey
    let hint: LocalizedStringKey?
    @Binding var date: Date?
    let defaultDate: () -> Date

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Toggle(isOn: isOn) {
                Text(label)
                    .font(MomentsFont.body())
                    .foregroundStyle(MomentsColor.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .tint(MomentsColor.accent)
            .accessibilityHint(hint.map { Text($0) } ?? Text(verbatim: ""))
            if let hint {
                Text(hint)
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    // Read as the toggle's hint instead.
                    .accessibilityHidden(true)
            }
            if let value = date {
                DatePicker(
                    selection: Binding(get: { value }, set: { date = $0 }),
                    displayedComponents: [.date, .hourAndMinute]
                ) { Text(label) }
                .labelsHidden()
                .tint(MomentsColor.accent)
            }
        }
    }

    private var isOn: Binding<Bool> {
        Binding(get: { date != nil }, set: { date = $0 ? defaultDate() : nil })
    }
}

/// The words the event forms share.
enum HostEventFormText {
    /// The problems worth a sentence: a missing title or type only
    /// disables the button.
    static func messages(for problems: Set<EventForm.Problem>) -> [String] {
        let ordered: [EventForm.Problem] = [
            .titleTooLong, .typeTooLong, .mainCharactersTooLong, .descriptionTooLong, .endInPast, .endBeforeStart,
        ]
        return ordered.filter(problems.contains).compactMap { problem in
            switch problem {
            case .titleTooLong: String(localized: "The title can be at most \(EventFieldLimits.title) characters.")
            case .typeTooLong: String(localized: "The type can be at most \(EventFieldLimits.type) characters.")
            case .mainCharactersTooLong: String(localized: "Who it's about can be at most \(EventFieldLimits.mainCharacters) characters.")
            case .descriptionTooLong: String(localized: "The description can be at most \(EventFieldLimits.description) characters.")
            case .endInPast: String(localized: "The end date has passed. Pick a later one.")
            case .endBeforeStart: String(localized: "The end date is before the event date.")
            case .titleMissing, .typeMissing: nil
            }
        }
    }

    static func messages(for problems: Set<HostEventDatesModel.Problem>) -> [String] {
        let ordered: [HostEventDatesModel.Problem] = [.deleteInPast, .closeAfterDelete]
        return ordered.filter(problems.contains).map { problem in
            switch problem {
            case .deleteInPast: String(localized: "The deletion date has passed. Pick a later one, or turn it off.")
            case .closeAfterDelete: String(localized: "Uploads must close before the event is deleted.")
            }
        }
    }

    /// Why saving changes to an existing event didn't work.
    static func editMessage(for failure: HostSaveFailure) -> String {
        switch failure {
        case .offline: String(localized: "You're offline, so nothing changed. Try again when you're connected.")
        case .appTooOld: String(localized: "Update Moments to edit events.")
        case .rateLimited: String(localized: "Too many changes just now. Wait a minute and try again.")
        case .refused: String(localized: "These changes couldn't be saved. Check the dates and try again.")
        case .gone: String(localized: "This event was deleted.")
        case .failed: String(localized: "That didn't work, so nothing changed. Try again.")
        }
    }

    /// The start of the hour after `date` plus `days`, a tidy default.
    static func nextHour(after date: Date, addingDays days: Int, calendar: Calendar = .current) -> Date {
        let later = calendar.date(byAdding: .day, value: days, to: date) ?? date
        let hour = calendar.dateInterval(of: .hour, for: later)?.start ?? later
        return calendar.date(byAdding: .hour, value: 1, to: hour) ?? later
    }
}
