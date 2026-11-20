import DesignSystem
import FeatureHost
import MomentsAPI
import MomentsDomain
import SwiftUI
import UniformTypeIdentifiers
import UIKit

/// One hosted event: a card with its QR code and links to share, its stats,
/// then a row per thing to manage (moderate, privacy, dates, details).
/// Pull to refresh.
struct HostEventDetailView: View {
    @State private var model: HostEventDetailModel
    /// The list row, shown while the detail loads.
    let summary: AdminEvent
    let host: HomeView.Host

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var isConfirmingInviteCopy = false
    @State private var didCopyInvite = false
    @State private var editing: HostEventEdit?

    init(summary: AdminEvent, host: HomeView.Host) {
        self.init(summary: summary, host: host, model: HostEventDetailModel(eventID: summary.id, service: host.service, account: host.account))
    }

    /// With a model that may already be loaded (screenshot tests).
    init(summary: AdminEvent, host: HomeView.Host, model: HostEventDetailModel) {
        self.summary = summary
        self.host = host
        _model = State(initialValue: model)
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ScrollView { content }
                .refreshable { await model.load() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MomentsColor.background.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .task { await model.load() }
        // The "copied" label is a moment's confirmation, not a lasting state.
        .task(id: didCopyInvite) {
            guard didCopyInvite else { return }
            try? await Task.sleep(for: .seconds(4))
            didCopyInvite = false
        }
        .onChange(of: scenePhase) {
            guard scenePhase == .active else { return }
            Task { await model.load() }
        }
        .onChange(of: model.phase) {
            if let message = Self.message(for: model.phase) {
                AccessibilityNotification.Announcement(message).post()
            }
        }
        .sheet(item: $editing) { edit in
            switch edit {
            case .details: HostEditDetailsView(event: event, host: host, onDone: finishEditing)
            case .privacy: HostEditPrivacyView(event: event, host: host, onDone: finishEditing)
            case .dates: HostEditDatesView(event: event, host: host, onDone: finishEditing)
            }
        }
        .confirmationDialog(
            Text("Copy the invite link?"),
            isPresented: $isConfirmingInviteCopy,
            titleVisibility: .visible
        ) {
            Button("Copy invite link", action: copyInvite)
        } message: {
            Text("Anyone with this link can open the event without its PIN. Share it only with your guests.")
        }
    }

    var topBar: some View {
        HStack {
            Button { dismiss() } label: {
                Label("Events", systemImage: "chevron.backward")
                    .frame(minWidth: Radius.minimumTapTarget, minHeight: Radius.minimumTapTarget, alignment: .leading)
                    .contentShape(Rectangle())
            }
            Spacer()
        }
        .font(MomentsFont.body())
        .foregroundStyle(MomentsColor.text)
        .padding(.horizontal, Spacing.lg)
    }

    /// Everything below the top bar, without the scroll view (also rendered
    /// by screenshot tests).
    var content: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text(event.title)
                    .font(MomentsFont.display(.title2))
                    .foregroundStyle(MomentsColor.text)
                    .accessibilityAddTraits(.isHeader)
                Text(HostEventsView.dateLine(event))
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.textMuted)
            }
            if let message = Self.message(for: model.phase) { notice(message) }
            if let detail = model.detail {
                shareSection(detail.share)
                HostEventStatsView(analytics: detail.analytics)
                manageRows
            } else if model.phase == .loading || model.phase == .idle {
                ProgressView()
                    .tint(MomentsColor.text)
                    .frame(maxWidth: .infinity)
                    .padding(.top, Spacing.xl)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Spacing.lg)
    }

    private var event: Event { model.detail?.summary.event ?? summary.event }

    /// Everything the host can change, one row each, in one card.
    private var manageRows: some View {
        VStack(spacing: 0) {
            NavigationLink(value: HostModerationRoute(eventID: event.id, title: event.title)) {
                HostManageRow(title: "Moderate moments", detail: String(localized: "Hide or delete what shouldn't stay"), systemImage: "square.grid.3x3")
            }
            rowDivider
            Button { editing = .privacy } label: {
                HostManageRow(title: "Privacy", detail: Self.privacyLine(event), systemImage: "lock")
            }
            rowDivider
            Button { editing = .dates } label: {
                HostManageRow(title: "Dates", detail: Self.datesLine(event), systemImage: "calendar")
            }
            rowDivider
            Button { editing = .details } label: {
                HostManageRow(title: "Details", detail: String(localized: "Title, names and description"), systemImage: "pencil")
            }
        }
        .buttonStyle(.plain)
        .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.card))
    }

    private var rowDivider: some View {
        MomentsColor.border.frame(height: 1).padding(.leading, Spacing.md)
    }

    static func privacyLine(_ event: Event) -> String {
        event.accessMode == .private
            ? String(localized: "Private: guests need the PIN or invite link")
            : String(localized: "Public: anyone with the link can join")
    }

    /// When uploads stop (or stopped), and when it all goes:
    /// "Uploads close Sun 9 pm · deleted 15 Jul".
    static func datesLine(_ event: Event) -> String {
        func time(_ date: Date) -> String { date.formatted(date: .abbreviated, time: .shortened) }
        func day(_ date: Date) -> String { date.formatted(date: .abbreviated, time: .omitted) }
        switch HostEventDates(event) {
        case .archived:
            return String(localized: "Archived")
        case let .open(closesAt?, deletesOn?):
            return String(localized: "Uploads close \(time(closesAt)) · deleted \(day(deletesOn))")
        case let .open(closesAt?, nil):
            return String(localized: "Uploads close \(time(closesAt))")
        case let .open(nil, deletesOn?):
            return String(localized: "Open for uploads · deleted \(day(deletesOn))")
        case .open(nil, nil):
            return String(localized: "Open for uploads")
        case let .closed(closedAt?, deletesOn?):
            return String(localized: "Uploads closed \(time(closedAt)) · deleted \(day(deletesOn))")
        case let .closed(closedAt?, nil):
            return String(localized: "Uploads closed \(time(closedAt))")
        case let .closed(nil, deletesOn?):
            return String(localized: "Deleted on \(day(deletesOn))")
        case .closed(nil, nil):
            return String(localized: "Uploads closed")
        }
    }

    private func shareSection(_ share: EventShareLinks) -> some View {
        VStack(spacing: Spacing.md) {
            EventQRCodeView(url: share.eventURL)
                .frame(maxWidth: 320)
            Text(share.eventURL.absoluteString)
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.textMuted)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
            ShareLink(item: share.eventURL) {
                Label("Share the event link", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(.momentsPrimary)
            if share.inviteURL != nil {
                Button { isConfirmingInviteCopy = true } label: {
                    Label(didCopyInvite ? "Invite link copied" : "Copy invite link", systemImage: "key")
                }
                .buttonStyle(.momentsSecondary)
                Text("For private events. It skips the PIN, so share it only with your guests.")
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.textMuted)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity)
        .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.sheet))
    }

    /// Shows a saved event as the server returned it (a reload could be
    /// skipped while another is in flight); the list behind catches up.
    private func finishEditing(_ saved: AdminEventDetail?) {
        editing = nil
        guard let saved else { return }
        model.apply(saved)
        Task { await host.events.load() }
    }

    private func copyInvite() {
        guard let url = model.detail?.share.inviteURL else { return }
        // Not synced to other devices, and gone from the clipboard after 10 minutes.
        UIPasteboard.general.setItems(
            [[UTType.url.identifier: url]],
            options: [.localOnly: true, .expirationDate: Date.now.addingTimeInterval(600)]
        )
        didCopyInvite = true
        AccessibilityNotification.Announcement(String(localized: "Invite link copied")).post()
    }

    private func notice(_ text: String) -> some View {
        Text(text)
            .font(MomentsFont.caption())
            .foregroundStyle(MomentsColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func message(for phase: HostEventDetailModel.Phase) -> String? {
        switch phase {
        case .idle, .loading, .loaded: nil
        case .gone: String(localized: "This event was deleted.")
        case .failed(.offline): String(localized: "You're offline. Pull down to try again.")
        case .failed(.appTooOld): String(localized: "Update Moments to see this event.")
        case .failed(.planRequired): String(localized: "Your hosting plan doesn't allow this right now. Resubscribe to bring everything back.")
        case .failed(.failed): String(localized: "This event couldn't be loaded. Pull down to try again.")
        }
    }
}

/// One thing to manage: icon, title, current state, chevron.
struct HostManageRow: View {
    let title: LocalizedStringKey
    let detail: String
    let systemImage: String
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: Spacing.sm) {
            // Large text: the words need the width more than the icon does.
            if !typeSize.isAccessibilitySize {
                Image(systemName: systemImage)
                    .font(.system(size: 18))
                    .foregroundStyle(MomentsColor.accent)
                    .frame(width: 28)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(title)
                    .font(MomentsFont.body())
                    .foregroundStyle(MomentsColor.text)
                Text(detail)
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.forward")
                .foregroundStyle(MomentsColor.textMuted)
                .accessibilityHidden(true)
        }
        .padding(Spacing.md)
        .frame(minHeight: Radius.minimumTapTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// The stat tiles and the 14-day upload bars.
struct HostEventStatsView: View {
    let analytics: EventAnalytics
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text("Stats")
                .font(MomentsFont.body().bold())
                .foregroundStyle(MomentsColor.text)
                .accessibilityAddTraits(.isHeader)
            LazyVGrid(columns: columns, alignment: .leading, spacing: Spacing.sm) {
                ForEach(HostEventStats.tiles(analytics)) { tile in
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        Text(tile.value)
                            .font(MomentsFont.display(.title3))
                            .foregroundStyle(MomentsColor.text)
                        Text(tile.title)
                            .font(MomentsFont.caption())
                            .foregroundStyle(MomentsColor.textMuted)
                    }
                    .padding(Spacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.card))
                    .accessibilityElement(children: .combine)
                }
            }
            ActivityBars(days: HostEventStats.lastTwoWeeks(analytics.activity))
        }
    }

    private var columns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: Spacing.sm), count: typeSize.isAccessibilitySize ? 1 : 2)
    }
}

/// Uploads per day, oldest first. Static: nothing animates.
struct ActivityBars: View {
    let days: [EventAnalytics.DayCount]

    var body: some View {
        let peak = max(days.map(\.count).max() ?? 0, 1)
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Uploads, last 14 days")
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .bottom, spacing: 4) {
                ForEach(days, id: \.day) { day in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(day.count > 0 ? MomentsColor.accent : MomentsColor.border)
                        .frame(height: max(4, 72 * CGFloat(day.count) / CGFloat(peak)))
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(height: 72, alignment: .bottom)
        }
        .padding(Spacing.md)
        .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Uploads in the last 14 days: \(days.reduce(0) { $0 + $1.count })"))
    }
}
