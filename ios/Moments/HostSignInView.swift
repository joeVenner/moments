import DesignSystem
import FeatureHost
import SwiftUI

/// The host's sign-in form, shown as a sheet from home. Uses the event
/// admin login for now (Sign in with Apple and email codes come later).
struct HostSignInView: View {
    let account: HostAccount
    let onSignedIn: () -> Void
    let onCancel: () -> Void

    @State private var username = ""
    @State private var password = ""
    @State private var failure: HostAccount.SignInFailure?
    @FocusState private var focus: Field?

    private enum Field { case username, password }

    var body: some View {
        ScrollView { form }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MomentsColor.background.ignoresSafeArea())
        .onChange(of: username) { failure = nil }
        .onChange(of: password) { failure = nil }
        .onAppear { focus = .username }
        // Never leave a typed password behind.
        .onDisappear { password = "" }
        // A sign-in can't be walked away from half-way.
        .interactiveDismissDisabled(account.isSigningIn)
        .privacyShielded()
    }

    /// The form without its scroll view (also rendered by screenshot tests).
    var form: some View {
        VStack(spacing: Spacing.md) {
            Text("Host sign-in")
                .font(MomentsFont.display(.title2))
                .foregroundStyle(MomentsColor.text)
                .accessibilityAddTraits(.isHeader)
            Text("Sign in with your event admin login to see and manage your events.")
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
                .multilineTextAlignment(.center)
            TextField(text: $username, prompt: Text("Username").foregroundStyle(MomentsColor.textMuted)) { Text("Username") }
                .credentialInput(.username)
                .submitLabel(.next)
                .focused($focus, equals: .username)
                .onSubmit { focus = .password }
                .momentsField()
            SecureField(text: $password, prompt: Text("Password").foregroundStyle(MomentsColor.textMuted)) { Text("Password") }
                .credentialInput(.password)
                .submitLabel(.go)
                .focused($focus, equals: .password)
                .onSubmit(signIn)
                .momentsField()
            if let failure {
                Text(Self.message(for: failure))
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.accent)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button(action: signIn) {
                if account.isSigningIn {
                    ProgressView().tint(MomentsColor.text)
                        .accessibilityLabel(Text("Signing in"))
                } else {
                    Text("Sign in")
                }
            }
            .buttonStyle(.momentsPrimary)
            .disabled(!canSubmit)
            Button("Cancel", action: onCancel)
                .buttonStyle(.momentsSecondary)
                .disabled(account.isSigningIn)
        }
        .padding(Spacing.lg)
        .padding(.top, Spacing.xl)
    }

    private var canSubmit: Bool {
        !account.isSigningIn && !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty
    }

    private func signIn() {
        guard canSubmit else { return }
        Task {
            switch await account.signIn(username: username, password: password) {
            case .signedIn:
                password = ""
                onSignedIn()
            case let .failed(reason):
                password = ""
                failure = reason
                focus = .password
                AccessibilityNotification.Announcement(Self.message(for: reason)).post()
            case .ignored:
                break
            }
        }
    }

    static func message(for failure: HostAccount.SignInFailure) -> String {
        switch failure {
        case .invalidCredentials: String(localized: "Incorrect username or password.")
        case .locked: String(localized: "Too many attempts. Try again in 15 minutes.")
        case .unavailable: String(localized: "Host sign-in isn't available right now.")
        case .appTooOld: String(localized: "Update Moments to sign in.")
        case .offline: String(localized: "You're offline. Check your connection and try again.")
        case .failed: String(localized: "Couldn't sign in. Try again.")
        }
    }
}

private enum CredentialKind { case username, password }

private extension View {
    @ViewBuilder func credentialInput(_ kind: CredentialKind) -> some View {
        #if os(iOS)
        switch kind {
        case .username:
            textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
        case .password:
            textContentType(.password)
        }
        #else
        self
        #endif
    }
}
