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
    @Environment(\.openURL) private var openURL
    @State private var isConfirmingInviteCopy = false
    @State private var didCopyInvite = false
    @State private var editing: HostEventEdit?
    @State private var isDownloading = false
    /// The first appearance loads through `.task`; later ones reload.
    @State private var hasAppeared = false

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
        .navigationBarHiddenKeepingSwipeBack()
        .task { await model.load() }
        // Back from moderation: the "to review" count may have changed.
        .onAppear {
            if hasAppeared { Task { await model.load() } }
            hasAppeared = true
        }
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
        .sheet(isPresented: $isDownloading) {
            EventDownloadView(eventID: event.id, visibleMoments: visibleMoments, host: host)
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
                manageRows(detail.share)
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
    private var visibleMoments: Int { model.detail.map { Self.visibleMoments($0.analytics) } ?? 0 }
    private var toReviewCount: Int { model.detail?.summary.toReviewCount ?? summary.toReviewCount }

    /// Everything the host can change, one row each, in one card.
    private func manageRows(_ share: EventShareLinks) -> some View {
        VStack(spacing: 0) {
            NavigationLink(value: HostModerationRoute(eventID: event.id, title: event.title)) {
                HostManageRow(
                    title: "Moderate moments", detail: String(localized: "Hide or delete what shouldn't stay"),
                    systemImage: "square.grid.3x3", badge: toReviewCount
                )
            }
            rowDivider
            if let slideshow = Self.slideshowURL(share.eventURL) {
                // The slideshow is for a big screen's browser: the app's
                // links leave it out, so Safari opens it rather than this app.
                Menu {
                    Button { openURL(slideshow) } label: { Label("Open in Safari", systemImage: "safari") }
                    ShareLink(item: slideshow) { Label("Share the slideshow link", systemImage: "square.and.arrow.up") }
                } label: {
                    HostManageRow(
                        title: "Slideshow", detail: Self.slideshowLine(event),
                        systemImage: "play.rectangle", trailingSymbol: "ellipsis"
                    )
                }
                .accessibilityHint(Text("Opens or shares the slideshow"))
                rowDivider
            }
            Button { isDownloading = true } label: {
                HostManageRow(
                    title: "Download everything", detail: EventDownloadView.rowLine(visibleMoments: visibleMoments),
                    systemImage: "arrow.down.circle"
                )
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

    /// The moments guests can see: hidden ones stay out of the download.
    static func visibleMoments(_ analytics: EventAnalytics) -> Int {
        max(0, analytics.totalMoments - analytics.hiddenMoments)
    }

    /// On a private event the web slideshow asks for the PIN itself.
    static func slideshowLine(_ event: Event) -> String {
        event.accessMode == .private
            ? String(localized: "Play moments live on a big screen. It asks for the event's PIN.")
            : String(localized: "Play moments live on a big screen")
    }

    /// The event's web slideshow: its link with "/slideshow" added and any
    /// query or fragment dropped (it never carries an invite).
    static func slideshowURL(_ eventURL: URL) -> URL? {
        guard var parts = URLComponents(url: eventURL, resolvingAgainstBaseURL: false) else { return nil }
        let path = parts.path.hasSuffix("/") ? String(parts.path.dropLast()) : parts.path
        guard !path.isEmpty else { return nil }
        parts.path = path + "/slideshow"
        parts.query = nil
        parts.fragment = nil
        return parts.url
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
            // Print is in the share sheet; the flyer carries the plain link,
            // never the invite (it may hang on a wall).
            ShareLink(
                item: EventFlyer(event: event, url: share.eventURL),
                preview: SharePreview(Text("Event flyer"))
            ) {
                Label("Print flyer", systemImage: "printer")
            }
            .buttonStyle(.momentsSecondary)
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
    /// Moments waiting for the host; shown only above zero.
    var badge = 0
    /// A chevron opens a screen; a menu row shows an ellipsis.
    var trailingSymbol = "chevron.forward"
    @Environment(\.dynamicTypeSize) private var typeSize

    /// What VoiceOver reads for the badge: the number alone says nothing.
    static func badgeLabel(_ count: Int) -> String? {
        count > 0 ? String(localized: "\(count) to review") : nil
    }

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
            if let label = Self.badgeLabel(badge) {
                Text(badge, format: .number)
                    .font(MomentsFont.caption().weight(.semibold))
                    .foregroundStyle(MomentsColor.background)
                    .padding(.horizontal, Spacing.xs)
                    .frame(minWidth: 24, minHeight: 24)
                    .background(MomentsColor.accent, in: Capsule())
                    // Never squeezed or wrapped by a long title at large sizes.
                    .fixedSize()
                    .accessibilityLabel(Text(label))
            }
            Image(systemName: trailingSymbol)
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
