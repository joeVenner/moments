import DesignSystem
import FeatureHost
import MomentsAPI
import MomentsDomain
import SwiftUI

/// The Hosting tab once signed in: the host's events grouped into Live now,
/// Upcoming and Past. Pull to refresh; sign out from the account menu; tap
/// an event for its QR code, links and stats.
struct HostEventsView: View {
    let host: HomeView.Host

    private var account: HostAccount { host.account }
    private var model: HostEventsModel { host.events }

    @Environment(\.scenePhase) private var scenePhase
    @State private var isConfirmingSignOut = false
    @State private var isCreatingEvent = false
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView { list }
                .refreshable { await model.load() }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(MomentsColor.background.ignoresSafeArea())
            .navigationBarHiddenKeepingSwipeBack()
            .navigationDestination(for: AdminEvent.self) { item in
                HostEventDetailView(summary: item, host: host)
            }
            .navigationDestination(for: HostModerationRoute.self) { route in
                HostModerationView(route: route, host: host)
            }
        }
        .task { await model.load() }
        .onChange(of: scenePhase) {
            guard scenePhase == .active else { return }
            Task { await model.load() }
        }
        // Expired or signed out: forget the list (the Hosting tab then shows
        // its sign-in card in place of this screen).
        .onChange(of: account.state, initial: true) {
            if account.state == .signedOut { model.reset() }
        }
        .onChange(of: model.phase) {
            if case let .failed(failure) = model.phase {
                AccessibilityNotification.Announcement(Self.message(for: failure)).post()
            }
        }
        .privacyShielded()
        // Every way the sheet closes refreshes the list, so a create that
        // may or may not have happened shows up.
        .sheet(isPresented: $isCreatingEvent, onDismiss: { Task { await model.load() } }) {
            HostNewEventView(host: host, onCreated: showCreated, onCancel: { isCreatingEvent = false })
        }
        .confirmationDialog(Text("Sign out of hosting on this phone?"), isPresented: $isConfirmingSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) {
                Task { await account.signOut() }
            }
        }
    }

    /// The title and events without the scroll view (also rendered by
    /// screenshot tests).
    var list: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            header
            if let plan = model.plan { HostPlanCard(plan: plan) }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Spacing.lg)
        .padding(.top, Spacing.xl)
        .padding(.bottom, Spacing.lg)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: Spacing.sm) {
            Text("Hosting")
                .font(MomentsFont.display())
                .foregroundStyle(MomentsColor.text)
                .accessibilityAddTraits(.isHeader)
                .frame(maxWidth: .infinity, alignment: .leading)
            // Icons only, so the row fits at the largest text sizes.
            Menu {
                Button("Sign out", role: .destructive) { isConfirmingSignOut = true }
            } label: {
                Image(systemName: "person.crop.circle")
                    .font(.system(size: 24))
                    .foregroundStyle(MomentsColor.textMuted)
                    .frame(width: Radius.minimumTapTarget, height: Radius.minimumTapTarget)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(Text("Account"))
            Button { isCreatingEvent = true } label: {
                Image(systemName: "plus")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(MomentsColor.onAccent)
                    .frame(width: Radius.minimumTapTarget, height: Radius.minimumTapTarget)
                    .background(MomentsColor.accent, in: Circle())
            }
            .accessibilityLabel(Text("New event"))
        }
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
                notice(String(localized: "No events yet. Tap + to create your first one."))
            case let .failed(failure):
                notice(Self.message(for: failure))
            }
        } else {
            if case let .failed(failure) = model.phase { notice(Self.message(for: failure)) }
            // Re-sorts each minute, so an event moves to Live now when it starts.
            TimelineView(.everyMinute) { context in
                let groups = HostEventGroups(events: model.events, now: context.date)
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    section("Live now", groups.live) { HostLiveEventCard(item: $0) }
                    section("Upcoming", groups.upcoming) { HostEventRow(item: $0, detail: Self.upcomingLine($0.event)) }
                    section("Past", groups.past) { HostEventRow(item: $0, detail: Self.pastLine($0.event)) }
                }
            }
            if model.isTruncated {
                notice(String(localized: "Showing the newest 500 events."))
            }
        }
    }

    /// Closes the sheet, shows the new event, and refreshes the list behind it.
    private func showCreated(_ detail: AdminEventDetail) {
        isCreatingEvent = false
        path.append(detail.summary)
    }

    @ViewBuilder
    private func section<Row: View>(
        _ title: LocalizedStringKey, _ items: [AdminEvent], @ViewBuilder row: @escaping (AdminEvent) -> Row
    ) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text(title)
                    .font(MomentsFont.heading())
                    .foregroundStyle(MomentsColor.text)
                    .accessibilityAddTraits(.isHeader)
                ForEach(items) { item in
                    NavigationLink(value: item) { row(item) }
                        .buttonStyle(.plain)
                }
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

    /// Under a live event's title: when uploads stop, if they ever do.
    static func liveLine(_ event: Event) -> String {
        guard let closesAt = event.effectiveUploadsCloseAt else { return String(localized: "Open for uploads") }
        let when = closesAt.formatted(date: .abbreviated, time: .shortened)
        return String(localized: "Uploads close \(when)")
    }

    /// The live card's line, with the guest limit when there is one.
    static func liveLine(_ item: AdminEvent) -> String {
        let line = liveLine(item.event)
        guard let cap = item.guestCap else { return line }
        return String(localized: "\(line) · up to \(cap) guests")
    }

    static func upcomingLine(_ event: Event) -> String {
        let when = (event.startsAt ?? event.createdAt).formatted(date: .abbreviated, time: .shortened)
        return String(localized: "Starts \(when)")
    }

    /// Under a past event's title: what happens to it next.
    static func pastLine(_ event: Event) -> String {
        if event.archivedAt != nil { return String(localized: "Archived") }
        guard let purgeAt = event.effectivePurgeAfter else { return String(localized: "Uploads closed") }
        let when = purgeAt.formatted(date: .abbreviated, time: .omitted)
        return String(localized: "Deleted on \(when)")
    }

    static func message(for failure: HostEventsModel.Failure) -> String {
        switch failure {
        case .offline: String(localized: "You're offline. Pull down to try again.")
        case .appTooOld: String(localized: "Update Moments to see your events.")
        case .planRequired: String(localized: "Your hosting plan doesn't allow this right now. Resubscribe to bring everything back.")
        case .failed: String(localized: "Your events couldn't be loaded. Pull down to try again.")
        }
    }
}

/// A live event: its title, Private chip and when uploads stop, over its
/// moment and guest counts.
struct HostLiveEventCard: View {
    let item: AdminEvent
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            // Large text: the chip goes under the title so neither wraps mid-word.
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.xs))
                : AnyLayout(HStackLayout(alignment: .top, spacing: Spacing.sm))
            layout {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(item.event.title)
                        .font(MomentsFont.heading())
                        .foregroundStyle(MomentsColor.text)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(HostEventsView.liveLine(item))
                        .font(MomentsFont.caption())
                        .foregroundStyle(MomentsColor.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                HostEventChips(item: item)
            }
            // Side by side when the three labels fit, stacked otherwise
            // (large text, or a longer language), so none truncates.
            if typeSize.isAccessibilitySize {
                VStack(spacing: Spacing.xs) { statTiles }
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: Spacing.xs) { statTiles }
                    VStack(spacing: Spacing.xs) { statTiles }
                }
            }
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.sheet))
        .overlay(RoundedRectangle(cornerRadius: Radius.sheet).stroke(MomentsColor.accent.opacity(0.6)))
        .accessibilityElement(children: .combine)
    }
    @ViewBuilder private var statTiles: some View {
        HostStatTile(value: item.momentCount, label: "Moments")
        HostStatTile(value: item.participantCount, label: "Guests")
        // Orange only when something waits, like the design.
        HostStatTile(value: item.toReviewCount, label: "To review", isHighlighted: item.toReviewCount > 0)
    }
}

/// The host's plan above their events: its guest limit, then whether it
/// renews, ends or needs attention, and how many events can still be made.
struct HostPlanCard: View {
    let plan: HostPlan

    var body: some View {
        let status = HostPlanStatus(plan)
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text("Plan for \(plan.guestCap) guests")
                .font(MomentsFont.heading())
                .foregroundStyle(MomentsColor.text)
            Text(Self.detailLine(status, creatable: plan.creatableEventCount))
                .font(MomentsFont.caption())
                // Orange only when the host has something to fix or save.
                .foregroundStyle(status.needsAttention ? MomentsColor.accent : MomentsColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.sheet))
        .accessibilityElement(children: .combine)
    }

    static func detailLine(_ status: HostPlanStatus, creatable: Int?) -> String {
        let statusText = switch status {
        case let .renews(date): String(localized: "Renews \(date.formatted(date: .abbreviated, time: .omitted))")
        case let .ends(date): String(localized: "Ends \(date.formatted(date: .abbreviated, time: .omitted))")
        case .paymentFailed: String(localized: "Payment failed. Update it in Settings.")
        case let .ended(until?): String(localized: "Hosting ended. Download until \(until.formatted(date: .abbreviated, time: .omitted)).")
        case .ended(nil): String(localized: "Hosting ended")
        }
        guard let creatable else { return statusText }
        let left = String(localized: "\(creatable) events left")
        return String(localized: "\(statusText) · \(left)")
    }
}

private extension HostPlanStatus {
    var needsAttention: Bool {
        switch self {
        case .renews, .ends: false
        case .paymentFailed, .ended: true
        }
    }
}

/// A count over its label, e.g. 128 / Moments.
struct HostStatTile: View {
    let value: Int
    let label: LocalizedStringKey
    var isHighlighted = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text(value, format: .number)
                .font(MomentsFont.number(.title2))
                .foregroundStyle(isHighlighted ? MomentsColor.accent : MomentsColor.text)
            Text(label)
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.textMuted)
        }
        .padding(Spacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MomentsColor.background, in: RoundedRectangle(cornerRadius: Radius.card))
        // Read as "128 Moments", not the number and label apart.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(value, format: .number) + Text(verbatim: " ") + Text(label))
    }
}

/// The chips an event row shows: TEST for the plan's test event, then Private.
struct HostEventChips: View {
    let item: AdminEvent

    var body: some View {
        let isTest = item.kind == .test
        let isPrivate = item.event.accessMode == .private
        if isTest || isPrivate {
            // Side by side when they fit; stacked on a narrow card or at
            // large text, so neither chip is clipped.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Spacing.xxs) { chips(isTest: isTest, isPrivate: isPrivate) }
                VStack(alignment: .leading, spacing: Spacing.xxs) { chips(isTest: isTest, isPrivate: isPrivate) }
            }
        }
    }

    @ViewBuilder private func chips(isTest: Bool, isPrivate: Bool) -> some View {
        if isTest { HostTestChip() }
        if isPrivate { HostPrivateChip() }
    }
}

/// Marks the plan's test event (a month, few guests): text, not colour.
struct HostTestChip: View {
    var body: some View {
        Text("TEST")
            .font(MomentsFont.caption().bold())
            .foregroundStyle(MomentsColor.text)
            .padding(.horizontal, Spacing.xs)
            .padding(.vertical, Spacing.xxs)
            .overlay(Capsule().stroke(MomentsColor.border))
            .accessibilityLabel(Text("Test event"))
    }
}

struct HostPrivateChip: View {
    var body: some View {
        Label("Private", systemImage: "lock.fill")
            .font(MomentsFont.caption())
            .foregroundStyle(MomentsColor.textMuted)
            .padding(.horizontal, Spacing.xs)
            .padding(.vertical, Spacing.xxs)
            .overlay(Capsule().stroke(MomentsColor.border))
    }
}

/// An upcoming or past event: title, one line of status, counts, chevron.
struct HostEventRow: View {
    let item: AdminEvent
    let detail: String

    /// Counts, with the guest limit when there is one ("Guests: 3 of 15").
    static func countsLine(_ item: AdminEvent) -> String {
        guard let cap = item.guestCap else {
            return String(localized: "Moments: \(item.momentCount) · Guests: \(item.participantCount)")
        }
        return String(localized: "Moments: \(item.momentCount) · Guests: \(item.participantCount) of \(cap)")
    }

    var body: some View {
        HStack(spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(item.event.title)
                    .font(MomentsFont.body().bold())
                    .foregroundStyle(MomentsColor.text)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                HostEventChips(item: item)
                Text(detail)
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.textMuted)
                Text(Self.countsLine(item))
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.forward")
                .foregroundStyle(MomentsColor.textMuted)
                .accessibilityHidden(true)
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, minHeight: Radius.minimumTapTarget, alignment: .leading)
        .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .accessibilityElement(children: .combine)
    }
}
