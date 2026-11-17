import DesignSystem
import MomentsDomain
import SwiftUI

/// Join flow for one event: PIN when private, then a nickname.
public struct JoinView: View {
    @Bindable var model: JoinModel
    @State private var pin = ""
    @State private var nickname = ""
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

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView()
                .tint(MomentsColor.textMuted)
                .frame(maxWidth: .infinity, minHeight: 200)
                .accessibilityLabel(Text("Loading the event"))

        case let .needsAccess(problem):
            heading(Text("Private event"), detail: "Enter the event PIN or open the private invitation link from the host.")
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
            heading(Text(verbatim: event.title), detail: "Enter your name to join")
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
            Button("Join the Feed", action: submitNickname)
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
        Task { await model.join(nickname: nickname) }
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
        }
    }

    private func failureTitle(_ failure: JoinModel.Failure) -> LocalizedStringKey {
        switch failure {
        case .eventNotFound: "Event not found"
        case .upgradeRequired: "Update required"
        case .accessUnavailable: "Private events are unavailable"
        case .temporary: "Can't reach Moments"
        case .storage: "Couldn't use this device's storage"
        }
    }

    private func failureDetail(_ failure: JoinModel.Failure) -> LocalizedStringKey {
        switch failure {
        case .eventNotFound: "Check the link or QR code with the host."
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
