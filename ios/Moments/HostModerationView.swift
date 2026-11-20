import DesignSystem
import FeatureGuest
import FeatureHost
import MomentsAPI
import MomentsDomain
import SwiftUI

/// Opens an event's moderation grid from its detail screen.
struct HostModerationRoute: Hashable {
    let eventID: String
    let title: String
}

/// Every moment of one event, hidden ones included. Tap a moment to hide
/// it from guests, show it again, or delete it.
struct HostModerationView: View {
    let route: HostModerationRoute
    @State private var model: HostModerationModel
    @State private var thumbnails: ThumbnailLoader

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    /// Ids, not copies: a reload while a dialog is open must not leave it
    /// offering "Hide" for a moment that is hidden already (or gone).
    @State private var selectedID: String?
    @State private var deletingID: String?

    init(route: HostModerationRoute, host: HomeView.Host) {
        self.init(route: route, host: host, model: HostModerationModel(eventID: route.eventID, service: host.service, account: host.account))
    }

    /// With a model that may already be loaded (screenshot tests).
    init(route: HostModerationRoute, host: HomeView.Host, model: HostModerationModel) {
        self.route = route
        _model = State(initialValue: model)
        // Host media URLs carry their own short-lived signature: no grant.
        _thumbnails = State(initialValue: ThumbnailLoader(fetcher: host.mediaFetcher, accessGrant: { nil }))
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
        // Hidden moments' bitmaps shouldn't outlive the screen.
        .onDisappear {
            let loader = thumbnails
            Task { await loader.removeAll() }
        }
        .onChange(of: scenePhase) {
            guard scenePhase == .active else { return }
            Task { await model.load() }
        }
        .onChange(of: model.phase) {
            if let message = HostModeration.message(for: model.phase) {
                AccessibilityNotification.Announcement(message).post()
            }
        }
        .onChange(of: model.actionFailure) {
            if let failure = model.actionFailure {
                AccessibilityNotification.Announcement(HostModeration.message(for: failure)).post()
            }
        }
        // One dialog per tap (never one opened from another, which SwiftUI
        // can drop); its Delete is the confirmation.
        .confirmationDialog(
            Text("What should happen to this moment?"),
            isPresented: isPresented($selectedID),
            titleVisibility: .visible,
            presenting: moment(selectedID)
        ) { moment in
            if moment.isHidden {
                Button("Show to guests") { setHidden(false, moment) }
            } else {
                Button("Hide from guests") { setHidden(true, moment) }
            }
            Button("Delete", role: .destructive) { delete(moment) }
        } message: { _ in
            Text("Deleting removes it for everyone, files included. This can't be undone.")
        }
        // VoiceOver's Delete action asks here.
        .confirmationDialog(
            Text("Delete this moment?"),
            isPresented: isPresented($deletingID),
            titleVisibility: .visible,
            presenting: moment(deletingID)
        ) { moment in
            Button("Delete", role: .destructive) { delete(moment) }
        } message: { _ in
            Text("It's removed for everyone, files included. This can't be undone.")
        }
    }

    var topBar: some View {
        HStack {
            Button { dismiss() } label: {
                Label("Event", systemImage: "chevron.backward")
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
        VStack(alignment: .leading, spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text("Moderate moments")
                    .font(MomentsFont.display(.title2))
                    .foregroundStyle(MomentsColor.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(route.title)
                    .font(MomentsFont.body())
                    .foregroundStyle(MomentsColor.text)
                    .fixedSize(horizontal: false, vertical: true)
                if model.phase == .loaded || !model.moments.isEmpty {
                    Text(HostModeration.summary(total: model.moments.count, hidden: model.hiddenCount))
                        .font(MomentsFont.caption())
                        .foregroundStyle(MomentsColor.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let failure = model.actionFailure { actionNotice(failure) }
            if let message = HostModeration.message(for: model.phase) { notice(message) }
            if !model.moments.isEmpty { filterTabs }
            grid
            if model.isTruncated {
                notice(String(localized: "Showing the newest 500 moments."))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Spacing.lg)
    }

    @ViewBuilder private var grid: some View {
        if model.moments.isEmpty {
            switch model.phase {
            case .idle, .loading:
                ProgressView()
                    .tint(MomentsColor.text)
                    .frame(maxWidth: .infinity)
                    .padding(.top, Spacing.xl)
            case .loaded:
                notice(String(localized: "No moments yet."))
            case .gone, .failed:
                EmptyView()
            }
        } else if model.visibleMoments.isEmpty {
            notice(HostModeration.emptyMessage(for: model.filter))
        } else {
            HostMomentGrid(moments: model.visibleMoments, pendingIDs: model.pendingIDs, thumbnails: thumbnails) { action in
                switch action {
                case let .choose(moment): selectedID = moment.id
                case let .setHidden(isHidden, moment): setHidden(isHidden, moment)
                case let .delete(moment): deletingID = moment.id
                }
            }
        }
    }

    /// All, Reported and Hidden, each with its count.
    private var filterTabs: some View {
        HStack(spacing: Spacing.xxs) {
            ForEach(HostModerationModel.Filter.allCases, id: \.self) { filter in
                let isSelected = model.filter == filter
                Button { model.filter = filter } label: {
                    Text(HostModeration.tabTitle(for: filter, count: model.count(for: filter)))
                        .font(MomentsFont.body(.subheadline).weight(isSelected ? .semibold : .medium))
                        .foregroundStyle(isSelected ? MomentsColor.text : MomentsColor.textMuted)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity, minHeight: Radius.minimumTapTarget)
                        .background(isSelected ? MomentsColor.border : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? [.isSelected] : [])
            }
        }
        .padding(Spacing.xxs)
        .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).stroke(MomentsColor.border))
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isTabBar)
    }

    private func setHidden(_ isHidden: Bool, _ moment: AdminMoment) {
        Task { await model.setHidden(isHidden, momentID: moment.id) }
    }

    private func delete(_ moment: AdminMoment) {
        Task { await model.delete(momentID: moment.id) }
    }

    /// The moment as it is now, or nil once it's gone (closing the dialog).
    private func moment(_ id: String?) -> AdminMoment? {
        id.flatMap { id in model.moments.first { $0.id == id } }
    }

    private func actionNotice(_ failure: HostModerationModel.ActionFailure) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
            Text(HostModeration.message(for: failure))
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.text)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("OK") { model.dismissActionFailure() }
                .font(MomentsFont.caption().bold())
                .foregroundStyle(MomentsColor.accent)
                .frame(minWidth: Radius.minimumTapTarget, minHeight: Radius.minimumTapTarget)
        }
        .padding(.horizontal, Spacing.md)
        .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.card))
    }

    private func notice(_ text: String) -> some View {
        Text(text)
            .font(MomentsFont.caption())
            .foregroundStyle(MomentsColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func isPresented(_ id: Binding<String?>) -> Binding<Bool> {
        Binding(get: { moment(id.wrappedValue) != nil }, set: { if !$0 { id.wrappedValue = nil } })
    }
}

/// The square cells, three across (two at large text sizes).
struct HostMomentGrid: View {
    enum Action {
        case choose(AdminMoment)
        case setHidden(Bool, AdminMoment)
        case delete(AdminMoment)
    }

    let moments: [AdminMoment]
    let pendingIDs: Set<String>
    let thumbnails: ThumbnailLoader
    let perform: (Action) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let columns = Array(
            repeating: GridItem(.flexible(), spacing: Spacing.xxs),
            count: typeSize.isAccessibilitySize ? 2 : 3
        )
        LazyVGrid(columns: columns, spacing: Spacing.xxs) {
            ForEach(moments) { moment in
                let isPending = pendingIDs.contains(moment.id)
                Button { perform(.choose(moment)) } label: {
                    HostMomentCell(moment: moment, isPending: isPending, thumbnails: thumbnails)
                }
                .buttonStyle(.plain)
                .disabled(isPending)
                .accessibilityLabel(Text(HostModeration.label(for: moment)))
                .accessibilityValue(HostModeration.stateValue(for: moment, isPending: isPending))
                .accessibilityHint(Text("Shows the hide and delete options."))
                .accessibilityActions {
                    // Nothing to offer while a change is on its way.
                    if !isPending {
                        Button(moment.isHidden ? "Show to guests" : "Hide from guests") {
                            perform(.setHidden(!moment.isHidden, moment))
                        }
                        Button("Delete") { perform(.delete(moment)) }
                    }
                }
            }
        }
    }
}

/// One square thumbnail: dimmed with a badge when hidden, a play badge for
/// videos, a spinner while a change is on its way.
struct HostMomentCell: View {
    let moment: AdminMoment
    let isPending: Bool
    let thumbnails: ThumbnailLoader
    @State private var image: CGImage?
    @State private var failed = false

    /// About a third of the widest phone at 3x.
    private static let pixelSize = 440

    var body: some View {
        Rectangle()
            .fill(MomentsColor.surface)
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if let image {
                    Image(decorative: image, scale: 1)
                        .resizable()
                        .scaledToFill()
                        .opacity(moment.isHidden ? 0.35 : 1)
                } else if failed {
                    Image(systemName: "photo")
                        .foregroundStyle(MomentsColor.textMuted)
                }
            }
            .overlay(alignment: .topTrailing) {
                if moment.media.kind == .video { badge("play.fill").padding(Spacing.xxs) }
            }
            .overlay(alignment: .bottomLeading) {
                HStack(spacing: Spacing.xxs) {
                    if moment.isHidden { badge("eye.slash") }
                    if moment.isReported { reportedBadge }
                }
                .padding(Spacing.xxs)
            }
            .overlay {
                if isPending {
                    ProgressView()
                        .tint(MomentsColor.text)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(MomentsColor.background.opacity(0.5))
                }
            }
            .clipped()
            .contentShape(Rectangle())
            // A reload brings fresh signatures: the task restarts, and the
            // cache (keyed without the query) answers without a download.
            .task(id: moment.media.gridImageURLs) { await load() }
    }

    private func badge(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.caption)
            .foregroundStyle(MomentsColor.text)
            .padding(Spacing.xxs)
            .background(MomentsColor.background.opacity(0.7), in: Circle())
    }

    /// Light on dark, like the design: it has to read over any photo.
    private var reportedBadge: some View {
        Text("Reported")
            .font(MomentsFont.caption(.caption2).weight(.semibold))
            .foregroundStyle(MomentsColor.background)
            .padding(.horizontal, Spacing.xxs + 2)
            .padding(.vertical, 2)
            .background(MomentsColor.text, in: RoundedRectangle(cornerRadius: 6))
            .lineLimit(1)
    }

    private func load() async {
        let loader = thumbnails
        let pixelSize = Self.pixelSize
        do {
            image = try await GridImage.load(moment.media.gridImageURLs.compactMap(URL.init(string:))) { url in
                try await loader.image(at: url, maxPixelSize: pixelSize)
            }
            failed = false
        } catch is CancellationError {
            return
        } catch {
            failed = true
        }
    }
}

/// Pure wording for the moderation screen (tested without views).
enum HostModeration {
    static func summary(total: Int, hidden: Int) -> String {
        let moments = String(localized: "\(total) moments")
        guard hidden > 0 else { return moments }
        return "\(moments) · " + String(localized: "\(hidden) hidden")
    }

    /// Whole sentences, so each language can order the parts its own way.
    static func label(for moment: AdminMoment) -> String {
        let name = moment.uploaderName
        switch (moment.media.kind == .video, moment.isHidden) {
        case (true, true): return String(localized: "Hidden video by \(name)")
        case (true, false): return String(localized: "Video by \(name)")
        case (false, true): return String(localized: "Hidden photo by \(name)")
        case (false, false): return String(localized: "Photo by \(name)")
        }
    }

    static func tabTitle(for filter: HostModerationModel.Filter, count: Int) -> String {
        switch filter {
        // The word, then the count: a "Hidden \(count)" key would clash
        // with "\(count) hidden" in the generated string symbols.
        case .all: String(localized: "moderation.tab.all", defaultValue: "All") + " \(count.formatted())"
        // Its own key: French says "Signalés" here but "Signalé" on a tile.
        case .reported: String(localized: "moderation.tab.reported", defaultValue: "Reported") + " \(count.formatted())"
        case .hidden: String(localized: "Hidden") + " \(count.formatted())"
        }
    }

    static func emptyMessage(for filter: HostModerationModel.Filter) -> String {
        switch filter {
        case .all: String(localized: "No moments yet.")
        case .reported: String(localized: "No reported moments.")
        case .hidden: String(localized: "No hidden moments.")
        }
    }

    /// What VoiceOver adds after the label: updating, or how many guests
    /// reported it.
    static func stateValue(for moment: AdminMoment, isPending: Bool) -> Text {
        if isPending { return Text("Updating") }
        guard moment.isReported else { return Text(verbatim: "") }
        return Text("Reported by ^[\(moment.reportCount) guest](inflect: true)")
    }

    static func message(for phase: HostModerationModel.Phase) -> String? {
        switch phase {
        case .idle, .loading, .loaded: nil
        case .gone: String(localized: "This event was deleted.")
        case .failed(.offline): String(localized: "You're offline. Pull down to try again.")
        case .failed(.appTooOld): String(localized: "Update Moments to moderate this event.")
        case .failed(.planRequired): String(localized: "Your hosting plan doesn't allow this right now. Resubscribe to bring everything back.")
        case .failed(.failed): String(localized: "The moments couldn't be loaded. Pull down to try again.")
        }
    }

    static func message(for failure: HostModerationModel.ActionFailure) -> String {
        switch failure {
        case .offline: String(localized: "You're offline, so nothing changed. Try again when you're connected.")
        case .appTooOld: String(localized: "Update Moments to moderate this event.")
        case .mediaKept: String(localized: "The moment's files couldn't be deleted, so it was kept. Try again in a moment.")
        case .planRequired: String(localized: "Your hosting plan doesn't allow this right now. Resubscribe to bring everything back.")
        case .failed: String(localized: "That didn't work, so nothing changed. Try again.")
        }
    }
}
