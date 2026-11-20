import DesignSystem
import MomentsDomain
import SwiftUI

/// Join flow for one event: PIN when private, then the guest's face and
/// name on an invitation-style screen.
public struct JoinView: View {
    @Bindable var model: JoinModel
    @State private var pin = ""
    @State private var nickname = ""
    /// The face shown here is the one the guest joins with.
    @State private var avatarSeed = JoinModel.randomAvatarSeed()
    @Environment(\.dynamicTypeSize) private var typeSize
    @FocusState private var focusedField: Field?

    private enum Field: Hashable { case pin, nickname }

    public init(model: JoinModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                content
            }
            .padding(Spacing.lg)
            .frame(maxWidth: 480, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(MomentsColor.background)
        .task { await model.start() }
        // stepCount, not phase: a repeated problem leaves phase unchanged.
        .onChange(of: model.stepCount, initial: true) {
            focusAndAnnounce(model.phase)
        }
    }

    /// The current step without the scroll view (also rendered by
    /// screenshot tests).
    @ViewBuilder var content: some View {
        switch model.phase {
        case .loading:
            ProgressView()
                .tint(MomentsColor.textMuted)
                .frame(maxWidth: .infinity, minHeight: 200)
                .accessibilityLabel(Text("Loading the event"))

        case let .needsAccess(problem):
            heading(Text("Private event"), detail: "Enter the event PIN. It's on the invitation; an invite link skips this step.")
            SecureField(text: $pin, prompt: Text("Event PIN").foregroundStyle(MomentsColor.textMuted)) { Text("Event PIN") }
                .submitLabel(.go)
                .focused($focusedField, equals: .pin)
                .onSubmit(submitPIN)
                .momentsField()
            if let problem { problemText(accessMessage(problem)) }
            Button("Unlock", action: submitPIN)
                .buttonStyle(.momentsPrimary)
                .disabled(isBlank(pin) || model.isWorking)

        case let .needsNickname(event, problem):
            invitation(event)
            faceCard
            Text("Your name")
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.textMuted)
                .accessibilityHidden(true)
            TextField(text: $nickname, prompt: Text("Your name").foregroundStyle(MomentsColor.textMuted)) { Text("Your name") }
                .nicknameInput()
                .submitLabel(.join)
                .focused($focusedField, equals: .nickname)
                .onSubmit(submitNickname)
                .onChange(of: nickname) { _, value in
                    // The server counts UTF-16 units; trim whole characters off the end.
                    var limited = value
                    while limited.utf16.count > JoinModel.maxNicknameLength { limited.removeLast() }
                    if limited != value { nickname = limited }
                }
                .momentsField()
            if let problem { problemText(nicknameMessage(problem)) }
            Button("Join the event", action: submitNickname)
                .buttonStyle(.momentsPrimary)
                .disabled(isBlank(nickname) || model.isWorking)

        case let .joined(event, participant):
            heading(Text(verbatim: event.title), detail: "Welcome, \(participant.nickname)!")
            if model.hasUnsavedIdentity {
                problemText("Couldn't save your name on this device.")
                Button("Try again") { model.retrySaving() }
                    .buttonStyle(.momentsPrimary)
            }

        case let .failed(failure):
            heading(Text(failureTitle(failure)), detail: failureDetail(failure))
            if failure == .temporary || failure == .storage {
                Button("Try again") { Task { await model.retry() } }
                    .buttonStyle(.momentsPrimary)
                    .disabled(model.isWorking)
            }
        }
    }

    /// "You're invited", the event's name, and its type and date.
    private func invitation(_ event: Event) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("You're invited")
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.accent)
            Text(verbatim: event.title)
                .font(MomentsFont.display(.title))
                .foregroundStyle(MomentsColor.text)
                .accessibilityAddTraits(.isHeader)
                .fixedSize(horizontal: false, vertical: true)
            Self.eventLine(event)
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
        }
        .padding(.bottom, Spacing.sm)
    }

    static func eventLine(_ event: Event) -> Text { JoinEventLine(event).text }

    private var faceCard: some View {
        // Large text: the face goes above the words so they keep the width.
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.sm))
            : AnyLayout(HStackLayout(spacing: Spacing.md))
        return layout {
            AvatarView(seed: avatarSeed, size: 64)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text("This face goes next to everything you share.")
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    avatarSeed = JoinModel.randomAvatarSeed()
                } label: {
                    Label("New face", systemImage: "arrow.triangle.2.circlepath")
                        .font(MomentsFont.body())
                        .frame(minHeight: Radius.minimumTapTarget)
                }
                .foregroundStyle(MomentsColor.accent)
                .disabled(model.isWorking)
                .accessibilityHint(Text("Picks a different face"))
            }
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.card))
    }

    /// Titles are `Text` so user content (event names) is shown verbatim,
    /// never looked up or formatted as a localization key.
    private func heading(_ title: Text, detail: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            title
                .font(MomentsFont.display(.title))
                .foregroundStyle(MomentsColor.text)
                .accessibilityAddTraits(.isHeader)
            Text(detail)
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
        }
    }

    private func problemText(_ message: LocalizedStringResource) -> some View {
        Text(message)
            .font(MomentsFont.caption())
            .foregroundStyle(MomentsColor.accent)
    }

    private func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submitPIN() {
        guard !isBlank(pin), !model.isWorking else { return }
        let value = pin
        pin = ""
        Task { await model.submitPIN(value) }
    }

    private func submitNickname() {
        guard !isBlank(nickname), !model.isWorking else { return }
        Task { await model.join(nickname: nickname, avatarSeed: avatarSeed) }
    }

    /// Puts the keyboard on the field the step needs and reads problems aloud.
    private func focusAndAnnounce(_ phase: JoinModel.Phase) {
        let field: Field?
        switch phase {
        case let .needsAccess(problem):
            field = .pin
            if let problem { announce(accessMessage(problem)) }
        case let .needsNickname(_, problem):
            field = .nickname
            if let problem { announce(nicknameMessage(problem)) }
        case .joined, .failed, .loading:
            field = nil
        }
        // Next run loop: the field may be inserted in this same update, and
        // focusing a view that isn't there yet is dropped.
        Task { @MainActor in focusedField = field }
    }

    private func announce(_ message: LocalizedStringResource) {
        AccessibilityNotification.Announcement(String(localized: message)).post()
    }

    private func accessMessage(_ problem: JoinModel.AccessProblem) -> LocalizedStringResource {
        switch problem {
        case .wrongPIN: "That PIN or invitation is not valid."
        case .inviteRejected: "This invitation link is no longer valid. Enter the event PIN instead."
        case let .tooManyAttempts(seconds): "Too many attempts. Try again in \(max(1, (seconds + 59) / 60)) min."
        case .expired: "Your access to this event has expired. Enter the event PIN again."
        }
    }

    private func nicknameMessage(_ problem: JoinModel.NicknameProblem) -> LocalizedStringResource {
        switch problem {
        case .taken: "This nickname is already taken in this event."
        case .invalid: "Enter a name between 1 and 60 characters."
        case .busy: "Too many people are joining from this network. Try again in a minute."
        case .eventFull: "This event is full: it has as many guests as its host's plan allows."
        }
    }

    private func failureTitle(_ failure: JoinModel.Failure) -> LocalizedStringKey {
        switch failure {
        case .eventNotFound: "Event not found"
        case .eventNotHosted: "This event is no longer hosted"
        case .upgradeRequired: "Update required"
        case .accessUnavailable: "Private events are unavailable"
        case .temporary: "Can't reach Moments"
        case .storage: "Couldn't use this device's storage"
        }
    }

    private func failureDetail(_ failure: JoinModel.Failure) -> LocalizedStringKey {
        switch failure {
        case .eventNotFound: "Check the link or QR code with the host."
        case .eventNotHosted: "Its moments can't be viewed right now."
        case .upgradeRequired: "Update Moments from the App Store to join this event."
        case .accessUnavailable: "Please try again later."
        case .temporary: "Check your connection and try again."
        case .storage: "Unlock your phone and try again."
        }
    }
}

private extension View {
    /// iOS keyboard hints; the macOS build (package tests) has no equivalent.
    @ViewBuilder func nicknameInput() -> some View {
        #if os(iOS)
        textContentType(.nickname).textInputAutocapitalization(.words)
        #else
        self
        #endif
    }
}

/// The invitation's second line, "Wedding · 14 Jun 2026": a known type in
/// the guest's language, a custom one as the host wrote it, a blank one left
/// out. Decided here so it can be tested apart from the view.
struct JoinEventLine: Equatable {
    enum Kind: Equatable {
        case preset(EventTypePreset)
        case custom(String)
        case none
    }

    let kind: Kind
    let startsAt: Date?

    init(_ event: Event) {
        let written = event.type.trimmingCharacters(in: .whitespacesAndNewlines)
        if let preset = EventTypePreset.matching(written) {
            kind = .preset(preset)
        } else {
            kind = written.isEmpty ? .none : .custom(written)
        }
        startsAt = event.startsAt
    }

    var text: Text {
        let date = startsAt.map { Text($0, format: .dateTime.day().month().year()) }
        let type: Text? = switch kind {
        case let .preset(preset): Text(LocalizedStringKey(preset.storedValue))
        case let .custom(written): Text(verbatim: written)
        case .none: nil
        }
        switch (type, date) {
        case let (type?, date?): return type + Text(verbatim: " · ") + date
        case let (type?, nil): return type
        case let (nil, date?): return date
        case (nil, nil): return Text(verbatim: "")
        }
    }
}
