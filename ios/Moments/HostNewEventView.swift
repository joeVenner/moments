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

    @FocusState private var focus: Field?

    private enum Field { case title, type, people, description }

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
        ScrollView { form }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(MomentsColor.background.ignoresSafeArea())
            .onAppear { focus = .title }
            // Half-way through creating, the sheet stays until the answer.
            .interactiveDismissDisabled(model.phase == .saving)
            .onChange(of: model.phase) {
                switch model.phase {
                case let .saved(detail): onCreated(detail)
                case .signedOut: onCancel()
                case let .failed(failure):
                    AccessibilityNotification.Announcement(Self.message(for: failure, mayHaveCreated: model.mayHaveCreated)).post()
                case .editing, .saving: break
                }
            }
            .privacyShielded()
    }

    /// The form without its scroll view (also rendered by screenshot tests).
    var form: some View {
        let problems = model.problems()
        return VStack(alignment: .leading, spacing: Spacing.md) {
            Text("New event")
                .font(MomentsFont.display(.title2))
                .foregroundStyle(MomentsColor.text)
                .accessibilityAddTraits(.isHeader)
                .fixedSize(horizontal: false, vertical: true)
            HostFormField(label: "Title") {
                TextField(text: $model.form.title, prompt: prompt("Sara & Omar's wedding")) { Text("Title") }
                    .focused($focus, equals: .title)
                    .submitLabel(.next)
                    .onSubmit { focus = .type }
                    .momentsField()
            }
            HostFormField(label: "Type") {
                TextField(text: $model.form.type, prompt: prompt("Wedding, birthday, party…")) { Text("Type") }
                    .focused($focus, equals: .type)
                    .submitLabel(.next)
                    .onSubmit { focus = .people }
                    .momentsField()
            }
            HostFormField(label: "Who it's about (optional)") {
                TextField(text: $model.form.mainCharacters, prompt: prompt("Sara & Omar")) { Text("Who it's about") }
                    .focused($focus, equals: .people)
                    .submitLabel(.next)
                    .onSubmit { focus = .description }
                    .momentsField()
            }
            HostFormField(label: "Description (optional)") {
                TextField(text: $model.form.description, prompt: prompt("Shown to guests under the title"), axis: .vertical) {
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
                date: $model.form.startsAt,
                defaultDate: { Self.nextHour(after: .now, addingDays: 1) }
            )
            HostOptionalDate(
                label: "End date",
                hint: "Guests can share until then. The event and its photos and videos are deleted afterwards.",
                date: $model.form.endsAt,
                defaultDate: { Self.nextHour(after: model.form.startsAt ?? .now, addingDays: 7) }
            )
            ForEach(Self.messages(for: problems), id: \.self) { message in
                problemText(message)
            }
            // Stays after the host edits the form: the event may exist.
            if model.mayHaveCreated {
                problemText(Self.message(for: .failed, mayHaveCreated: true))
            } else if case let .failed(failure) = model.phase {
                problemText(Self.message(for: failure, mayHaveCreated: false))
            }
            Button(action: save) {
                if model.phase == .saving {
                    ProgressView().tint(MomentsColor.text)
                        .accessibilityLabel(Text("Creating the event"))
                } else if model.mayHaveCreated {
                    Text("Create anyway")
                } else {
                    Text("Create event")
                }
            }
            .buttonStyle(.momentsPrimary)
            .disabled(!problems.isEmpty || model.phase == .saving)
            Button("Cancel", action: onCancel)
                .buttonStyle(.momentsSecondary)
                .disabled(model.phase == .saving)
        }
        .padding(Spacing.lg)
        .onChange(of: model.form) { model.dismissFailure() }
        .onChange(of: Self.messages(for: problems)) { old, new in
            guard let added = new.first(where: { !old.contains($0) }) else { return }
            AccessibilityNotification.Announcement(added).post()
        }
    }

    private func save() {
        focus = nil
        Task { await model.save() }
    }

    private func prompt(_ text: LocalizedStringKey) -> Text {
        Text(text).foregroundStyle(MomentsColor.textMuted)
    }

    private func problemText(_ message: String) -> some View {
        Text(message)
            .font(MomentsFont.caption())
            .foregroundStyle(MomentsColor.accent)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// The problems worth a sentence: a missing title or type only
    /// disables the button.
    static func messages(for problems: Set<EventForm.Problem>) -> [String] {
        let ordered: [EventForm.Problem] = [
            .titleTooLong, .typeTooLong, .mainCharactersTooLong, .descriptionTooLong, .endInPast, .endBeforeStart,
        ]
        return ordered.filter(problems.contains).map { problem in
            switch problem {
            case .titleTooLong: String(localized: "The title can be at most \(EventFieldLimits.title) characters.")
            case .typeTooLong: String(localized: "The type can be at most \(EventFieldLimits.type) characters.")
            case .mainCharactersTooLong: String(localized: "Who it's about can be at most \(EventFieldLimits.mainCharacters) characters.")
            case .descriptionTooLong: String(localized: "The description can be at most \(EventFieldLimits.description) characters.")
            case .endInPast: String(localized: "The end date has passed. Pick a later one.")
            case .endBeforeStart: String(localized: "The end date is before the event date.")
            // Filtered out above.
            case .titleMissing, .typeMissing: ""
            }
        }
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

    /// The start of the hour after `date` plus `days`, a tidy default.
    static func nextHour(after date: Date, addingDays days: Int, calendar: Calendar = .current) -> Date {
        let later = calendar.date(byAdding: .day, value: days, to: date) ?? date
        let hour = calendar.dateInterval(of: .hour, for: later)?.start ?? later
        return calendar.date(byAdding: .hour, value: 1, to: hour) ?? later
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
