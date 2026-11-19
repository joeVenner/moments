import DesignSystem
import FeatureHost
import MomentsAPI
import MomentsDomain
import SwiftUI

/// The signed-in host's events, newest first. Pull to refresh; sign out in
/// the top bar; tap an event for its QR code, links and stats.
struct HostEventsView: View {
    let account: HostAccount
    let model: HostEventsModel
    let service: any HostService
    let onClose: () -> Void

    @Environment(\.scenePhase) private var scenePhase
    @State private var isConfirmingSignOut = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                topBar
                ScrollView { list }
                    .refreshable { await model.load() }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(MomentsColor.background.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: AdminEvent.self) { item in
                HostEventDetailView(summary: item, service: service, account: account)
            }
        }
        .task { await model.load() }
        .onChange(of: scenePhase) {
            guard scenePhase == .active else { return }
            Task { await model.load() }
        }
        // Expired or signed out (also before this appeared): forget the
        // list and go back home.
        .onChange(of: account.state, initial: true) {
            guard account.state == .signedOut else { return }
            model.reset()
            onClose()
        }
        .onChange(of: model.phase) {
            if case let .failed(failure) = model.phase {
                AccessibilityNotification.Announcement(Self.message(for: failure)).post()
            }
        }
        .privacyShielded()
        .confirmationDialog(Text("Sign out of hosting on this phone?"), isPresented: $isConfirmingSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) {
                Task { await account.signOut() }
            }
        }
    }

    /// The title and events without the scroll view (also rendered by
    /// screenshot tests).
    var list: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Hosted events")
                .font(MomentsFont.display(.title2))
                .foregroundStyle(MomentsColor.text)
                .accessibilityAddTraits(.isHeader)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Spacing.lg)
    }

    var topBar: some View {
        HStack {
            Button(action: onClose) {
                Label("Home", systemImage: "chevron.backward")
                    .frame(minWidth: Radius.minimumTapTarget, minHeight: Radius.minimumTapTarget, alignment: .leading)
                    .contentShape(Rectangle())
            }
            Spacer()
            Button { isConfirmingSignOut = true } label: {
                Text("Sign out")
                    .frame(minWidth: Radius.minimumTapTarget, minHeight: Radius.minimumTapTarget, alignment: .trailing)
                    .contentShape(Rectangle())
            }
        }
        .font(MomentsFont.body())
        .foregroundStyle(MomentsColor.text)
        .padding(.horizontal, Spacing.lg)
    }

    @ViewBuilder private var content: some View {
        if model.events.isEmpty {
            switch model.phase {
            case .idle, .loading:
                ProgressView()
                    .tint(MomentsColor.text)
                    .frame(maxWidth: .infinity)
                    .padding(.top, Spacing.xl)
            case .loaded:
                notice(String(localized: "No events yet. Create one on the web for now."))
            case let .failed(failure):
                notice(Self.message(for: failure))
            }
        } else {
            if case let .failed(failure) = model.phase { notice(Self.message(for: failure)) }
            ForEach(model.events) { item in
                NavigationLink(value: item) { HostEventRow(item: item) }
                    .buttonStyle(.plain)
            }
            if model.isTruncated {
                notice(String(localized: "Showing the newest 500 events."))
            }
        }
    }

    private func notice(_ text: String) -> some View {
        Text(text)
            .font(MomentsFont.caption())
            .foregroundStyle(MomentsColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func dateLine(_ event: Event) -> String {
        let date = (event.startsAt ?? event.createdAt).formatted(date: .abbreviated, time: .omitted)
        if event.archivedAt != nil { return String(localized: "\(date) · archived") }
        if !event.areUploadsOpen { return String(localized: "\(date) · uploads closed") }
        return date
    }

    static func message(for failure: HostEventsModel.Failure) -> String {
        switch failure {
        case .offline: String(localized: "You're offline. Pull down to try again.")
        case .appTooOld: String(localized: "Update Moments to see your events.")
        case .failed: String(localized: "Your events couldn't be loaded. Pull down to try again.")
        }
    }
}

/// One event in the host's list.
struct HostEventRow: View {
    let item: AdminEvent
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            // Large text: the badge goes under the title so neither wraps mid-word.
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.xs))
                : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: Spacing.sm))
            layout {
                Text(item.event.title)
                    .font(MomentsFont.body().bold())
                    .foregroundStyle(MomentsColor.text)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if item.event.accessMode == .private {
                    Label("Private", systemImage: "lock.fill")
                        .font(MomentsFont.caption())
                        .foregroundStyle(MomentsColor.textMuted)
                }
            }
            Text(HostEventsView.dateLine(item.event))
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.textMuted)
            Text("Moments: \(item.momentCount) · Guests: \(item.participantCount)")
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.textMuted)
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, minHeight: Radius.minimumTapTarget, alignment: .leading)
        .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .accessibilityElement(children: .combine)
    }
}
