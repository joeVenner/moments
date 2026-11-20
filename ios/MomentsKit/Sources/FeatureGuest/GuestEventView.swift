import DesignSystem
import MomentsAPI
import MomentsDomain
import SwiftUI

/// One event for a guest: the join flow, then the feed, highlights and
/// leaderboard as tabs once joined.
public struct GuestEventView: View {
    let join: JoinModel
    let dependencies: GuestDependencies
    /// Called when the feed loses access, to start a fresh join flow.
    let rejoin: () -> Void
    /// The guest left the event (everything deleted, identity forgotten).
    let onLeft: () -> Void
    /// Back to the app's home screen; nil hides the button (e.g. the App Clip).
    /// Uploads keep going in the background queue.
    let onHome: (() -> Void)?
    @State private var leave: LeaveModel?
    @State private var progress: UploadProgressModel?
    @State private var isShowingProgress = false
    @State private var isConfirmingLeave = false
    @State private var feed: FeedModel?
    @State private var highlights: HighlightsModel?
    @State private var leaderboard: LeaderboardModel?
    @State private var thumbnails: ThumbnailLoader?
    @State private var viewerImages: ThumbnailLoader?
    /// The open upload screen's model (fresh each time it opens).
    @State private var upload: UploadModel?
    /// The same model, kept until the sheet's dismissal is handled (the
    /// sheet binding is already nil by then).
    @State private var presentedUpload: UploadModel?
    /// Bumped when a batch is queued (for the haptic, played here because
    /// the sheet is already closing).
    @State private var sharedBatches = 0
    @State private var section = GuestEventSection.moments
    /// Sections are built when first shown, so joining loads only the feed.
    @State private var openedSections: Set<GuestEventSection> = [.moments]

    public init(
        join: JoinModel, dependencies: GuestDependencies, rejoin: @escaping () -> Void,
        onLeft: @escaping () -> Void = {}, onHome: (() -> Void)? = nil
    ) {
        self.join = join
        self.dependencies = dependencies
        self.rejoin = rejoin
        self.onLeft = onLeft
        self.onHome = onHome
    }

    public var body: some View {
        Group {
            if let feed, let highlights, let leaderboard, let thumbnails, let viewerImages {
                VStack(spacing: 0) {
                    if join.hasUnsavedIdentity { unsavedBanner }
                    if leave != nil || progress != nil || onHome != nil { topBar }
                    GuestEventHeader(event: feed.event, stats: feed.stats, myEntry: leaderboard.myEntry, section: $section)
                        // New moments change points too; the board waits 30 s between loads.
                        .task(id: feed.stats) { await leaderboard.loadIfStale() }
                    // Every opened section stays alive, keeping its scroll.
                    ZStack {
                        FeedView(model: feed, thumbnails: thumbnails, viewerImages: viewerImages, isSelected: section == .moments)
                            .sectionContent(isSelected: section == .moments)
                        if openedSections.contains(.highlights) {
                            HighlightsView(
                                model: highlights, thumbnails: thumbnails, viewerImages: viewerImages,
                                isSelected: section == .highlights
                            )
                                .sectionContent(isSelected: section == .highlights)
                        }
                        if openedSections.contains(.leaderboard) {
                            LeaderboardView(model: leaderboard, isSelected: section == .leaderboard)
                                .sectionContent(isSelected: section == .leaderboard)
                        }
                    }
                    .safeAreaInset(edge: .bottom) {
                        if section != .leaderboard { shareButton(feed) }
                    }
                    .haptic(.uploadComplete, trigger: sharedBatches)
                    .onChange(of: section) { openedSections.insert(section) }
                    if feed.phase == .accessLost || feed.phase == .guestRequired {
                        Button("Join again", action: rejoin)
                            .buttonStyle(.momentsPrimary)
                            .padding(Spacing.md)
                    }
                }
                .background(MomentsColor.background)
                // Deleting takes a few calls; nothing else may start meanwhile.
                .disabled(leave?.phase == .leaving)
                .accessibilityHidden(leave?.phase == .leaving)
                .overlay {
                    if leave?.phase == .leaving {
                        ZStack {
                            // Blocks scrolling and the tab bar, not just buttons.
                            MomentsColor.background.opacity(0.6).ignoresSafeArea()
                            ProgressView("Leaving…")
                                .tint(MomentsColor.text)
                                .foregroundStyle(MomentsColor.text)
                                .padding(Spacing.md)
                                .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.card))
                                .accessibilityElement(children: .combine)
                        }
                        .onAppear { AccessibilityNotification.Announcement("Leaving the event").post() }
                    }
                }
            } else {
                JoinView(model: join)
                    .safeAreaInset(edge: .top, alignment: .leading) {
                        if let onHome { homeButton(onHome).padding(.horizontal, Spacing.sm) }
                    }
            }
        }
        // However the sheet closes, unshared picks and files are dropped;
        // on real dismissal only (a picker shown over it must not count).
        .sheet(item: $upload, onDismiss: {
            presentedUpload?.discardAll()
            presentedUpload = nil
        }) { model in
            UploadView(model: model) { sharedBatches += 1 }
        }
        // The event ended for this guest: every tab stops; lost access also
        // drops cached images of the private event.
        .onChange(of: feed?.phase) {
            guard feed?.hasEnded == true else { return }
            // The event ended: an open upload screen closes and drops its picks.
            upload?.discardAll()
            upload = nil
            highlights?.end()
            leaderboard?.end()
            guard feed?.phase == .accessLost else { return }
            for loader in [thumbnails, viewerImages].compactMap(\.self) { Task { await loader.removeAll() } }
        }
        .onChange(of: join.phase, initial: true) { _, phase in
            guard case let .joined(event, participant) = phase, feed == nil else { return }
            let feedModel = FeedModel(
                event: event, participant: participant, slug: join.slug,
                service: dependencies.service, store: dependencies.store
            )
            thumbnails = ThumbnailLoader(fetcher: dependencies.mediaFetcher, accessGrant: feedModel.mediaAccessGrant)
            // Full-screen images may be originals: a larger download cap, but
            // only two at a time (up to 40 MB each in memory).
            viewerImages = ThumbnailLoader(
                fetcher: dependencies.mediaFetcher, accessGrant: feedModel.mediaAccessGrant,
                maxBytes: MediaFetcher.maxBytes, maxConcurrentLoads: 2
            )
            let highlightsModel = HighlightsModel(
                slug: join.slug,
                service: dependencies.service, store: dependencies.store
            )
            let leaderboardModel = LeaderboardModel(
                slug: join.slug, participantID: participant.id, service: dependencies.service, store: dependencies.store
            )
            // Hearts settled in one list show in the other; errors that end
            // the event are the feed's to show.
            feedModel.onReactionSettled = { [weak highlightsModel] id, state in
                highlightsModel?.applyServerReaction(momentID: id, state: state)
            }
            highlightsModel.onReactionSettled = { [weak feedModel] id, state in
                feedModel?.applyServerReaction(momentID: id, state: state)
            }
            highlightsModel.onFatalError = { [weak feedModel] error in feedModel?.endIfFatal(error) }
            leaderboardModel.onFatalError = { [weak feedModel] error in feedModel?.endIfFatal(error) }
            highlights = highlightsModel
            leaderboard = leaderboardModel
            feed = feedModel
            if let leaver = dependencies.leaver {
                leave = LeaveModel(
                    slug: join.slug, service: leaver, store: dependencies.store,
                    uploads: dependencies.uploads?.leaving
                )
            }
            if let source = dependencies.uploads?.progress {
                progress = UploadProgressModel.live(eventSlug: join.slug.value, source: source)
            }
        }
        .onChange(of: leave?.phase) { _, phase in
            guard phase == .left else { return }
            upload?.discardAll()
            upload = nil
            highlights?.end()
            leaderboard?.end()
            for loader in [thumbnails, viewerImages].compactMap(\.self) { Task { await loader.removeAll() } }
            onLeft()
        }
    }

    // MARK: - Leaving

    private var topBar: some View {
        HStack(spacing: 0) {
            if let onHome { homeButton(onHome) }
            Spacer()
            if let progress { uploadsButton(progress) }
            if let leave { eventMenu(leave) }
        }
        .padding(.horizontal, Spacing.sm)
    }

    private func homeButton(_ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "chevron.backward")
                .font(.title3)
                .foregroundStyle(MomentsColor.textMuted)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(Text("Home"))
    }

    /// Opens "Your uploads"; a count while some are under way, and a mark
    /// when one needs attention.
    private func uploadsButton(_ progress: UploadProgressModel) -> some View {
        Button { isShowingProgress = true } label: {
            HStack(spacing: Spacing.xs) {
                Image(systemName: progress.failedCount > 0 ? "exclamationmark.arrow.circlepath" : "arrow.up.circle")
                if progress.activeCount > 0 {
                    Text(progress.activeCount, format: .number)
                        .font(MomentsFont.caption().bold())
                }
            }
            .font(.title3)
            .foregroundStyle(progress.failedCount > 0 ? MomentsColor.accent : MomentsColor.textMuted)
            .frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel(Text("Your uploads"))
        .accessibilityValue(Text(uploadsSummary(progress)))
        // Follows the queue while the event is shown, so the count is live.
        .task { await progress.observe() }
        .sheet(isPresented: $isShowingProgress) { UploadProgressView(model: progress, eventTitle: feed?.event.title) }
    }

    private func uploadsSummary(_ progress: UploadProgressModel) -> String {
        var parts: [String] = []
        if progress.activeCount > 0 { parts.append(String(localized: "\(progress.activeCount) in progress")) }
        if progress.failedCount > 0 { parts.append(String(localized: "\(progress.failedCount) need attention")) }
        return parts.joined(separator: ", ")
    }

    private func eventMenu(_ leave: LeaveModel) -> some View {
        HStack {
            Menu {
                Button("Leave event…", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                    isConfirmingLeave = true
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
                    .foregroundStyle(MomentsColor.textMuted)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel(Text("Event options"))
            .disabled(leave.phase == .leaving)
        }
        .confirmationDialog("Leave this event?", isPresented: $isConfirmingLeave, titleVisibility: .visible) {
            Button("Leave and delete", role: .destructive) { Task { await leave.leave() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The photos and videos you shared from this app are deleted and your nickname is freed. Anything shared from the website stays. This can't be undone.")
        }
        .alert(
            "Couldn't leave the event",
            // Closed any way but "Try again": back to idle, so it doesn't reappear.
            isPresented: Binding(
                get: { leaveFailure(leave) != nil },
                set: { if !$0 { leave.dismissFailure() } }
            ),
            presenting: leaveFailure(leave)
        ) { _ in
            Button("Try again") { Task { await leave.leave() } }
            Button("Cancel", role: .cancel) {}
        } message: { failure in
            Text(leaveMessage(failure))
        }
    }

    private func leaveFailure(_ leave: LeaveModel) -> LeaveModel.Failure? {
        if case let .failed(failure) = leave.phase { failure } else { nil }
    }

    private func leaveMessage(_ failure: LeaveModel.Failure) -> LocalizedStringResource {
        switch failure {
        case .busy: "Too many requests right now. Try again in a minute."
        case .upgradeRequired: "Update Moments to leave this event."
        case .temporary: "Moments couldn't finish leaving the event. Try again to continue where it stopped."
        case .storage: "Your uploads are deleted, but this device couldn't forget your name. Try again."
        }
    }

    /// Shown under Moments and Highlights (insetting their content) when
    /// uploads are available and the event is open.
    @ViewBuilder private func shareButton(_ feed: FeedModel) -> some View {
        if let uploads = dependencies.uploads, !feed.hasEnded {
            shareButton(uploads)
        }
    }

    private func shareButton(_ uploads: UploadDependencies) -> some View {
        Button {
            let model = UploadModel(
                eventSlug: join.slug.value, staging: uploads.staging, importer: uploads.importer, submitter: uploads.submitter
            )
            presentedUpload = model
            upload = model
        } label: {
            Label("Share moments", systemImage: "plus")
                .font(MomentsFont.body().bold())
                .foregroundStyle(MomentsColor.onAccent)
                .padding(.horizontal, Spacing.lg)
                .frame(minHeight: 52)
                .background(MomentsColor.accent, in: Capsule())
        }
        .accessibilityHint(Text("Photos and videos from your library"))
        .padding(Spacing.md)
    }

    private var unsavedBanner: some View {
        HStack(spacing: Spacing.sm) {
            Text("Couldn't save your name on this device.")
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.text)
            Spacer()
            Button("Try again") { join.retrySaving() }
                .font(MomentsFont.caption().bold())
                .foregroundStyle(MomentsColor.accent)
                .frame(minHeight: Radius.minimumTapTarget)
        }
        .padding(.horizontal, Spacing.md)
        .background(MomentsColor.surface)
    }
}

/// The event's three sections, switched under its header.
enum GuestEventSection: String, CaseIterable, Identifiable, Hashable {
    case moments, highlights, leaderboard

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .moments: "Moments"
        case .highlights: "Highlights"
        case .leaderboard: "Leaderboard"
        }
    }
}

private extension View {
    /// A section out of sight: no touches, nothing read by VoiceOver.
    func sectionContent(isSelected: Bool) -> some View {
        opacity(isSelected ? 1 : 0)
            .allowsHitTesting(isSelected)
            .accessibilityHidden(!isSelected)
    }
}

/// The event's name, when sharing closes, and the section switcher.
struct GuestEventHeader: View {
    let event: Event
    /// The counts line; nil (an older server) keeps the sharing line alone.
    var stats: EventStats?
    /// The guest's leaderboard entry, for the points pill; nil hides it.
    var myEntry: LeaderboardEntry?
    @Binding var section: GuestEventSection
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            // Large text: the title needs the width, so the pill goes below.
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.sm))
                : AnyLayout(HStackLayout(alignment: .top, spacing: Spacing.sm))
            layout {
                titleBlock
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let myEntry { pointsPill(myEntry) }
            }
            sectionPicker
        }
        .padding(.horizontal, Spacing.md)
        .padding(.bottom, Spacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The guest's avatar and points; opens the leaderboard.
    private func pointsPill(_ entry: LeaderboardEntry) -> some View {
        Button { section = .leaderboard } label: {
            HStack(spacing: Spacing.xs) {
                GuestAvatar(nickname: entry.nickname, seed: entry.avatarSeed, size: 30)
                Text(Self.pointsLabel(entry.totalPoints))
                    .font(MomentsFont.caption().weight(.semibold))
                    .foregroundStyle(MomentsColor.text)
            }
            .padding(.leading, Spacing.xxs)
            .padding(.trailing, Spacing.sm)
            .frame(minHeight: 40)
            .background(MomentsColor.surface, in: Capsule())
            .overlay(Capsule().stroke(MomentsColor.border, lineWidth: 1))
            // The capsule looks 40 pt tall; the tap area is the full 44.
            .frame(minHeight: Radius.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("^[\(entry.totalPoints) point](inflect: true)"))
        .accessibilityHint(Text("Shows the leaderboard"))
    }

    /// "210 pts": short, for the pill.
    static func pointsLabel(_ points: Int) -> String {
        String(localized: "\(max(0, points)) pts")
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text(verbatim: event.title)
                .font(MomentsFont.display(.title))
                .foregroundStyle(MomentsColor.text)
                .accessibilityAddTraits(.isHeader)
                .fixedSize(horizontal: false, vertical: true)
            if let line = Self.headerLine(event, stats: stats) {
                Text(line)
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.textMuted)
                    // VoiceOver would read the separators as "dot".
                    .accessibilityLabel(Text(verbatim: line.replacingOccurrences(of: " · ", with: ", ")))
            }
        }
    }

    @ViewBuilder private var sectionPicker: some View {
        let picker = Picker(selection: $section) {
            ForEach(GuestEventSection.allCases) { Text($0.title).tag($0) }
        } label: {
            Text("Section")
        }
        .labelsHidden()
        // Segments truncate at large text sizes; a menu keeps the words whole.
        if typeSize.isAccessibilitySize {
            picker.pickerStyle(.menu).tint(MomentsColor.accent)
        } else {
            picker.pickerStyle(.segmented)
        }
    }

    /// "128 moments · 46 guests · open until 21 Nov, 21:00". Without counts,
    /// just "Sharing open until …"; nil when there is nothing to say.
    static func headerLine(_ event: Event, stats: EventStats?) -> String? {
        guard let stats else { return sharingLine(event) }
        var parts = [
            String(localized: "\(stats.momentCount) moments"),
            String(localized: "\(stats.guestCount) guests"),
        ]
        if let when = openUntil(event) { parts.append(String(localized: "open until \(when)")) }
        return parts.joined(separator: " · ")
    }

    /// "Sharing open until 21 Nov, 21:00"; nil once closed or with no end.
    static func sharingLine(_ event: Event) -> String? {
        guard let when = openUntil(event) else { return nil }
        return String(localized: "Sharing open until \(when)")
    }

    /// When sharing closes, formatted; nil once closed or with no end.
    private static func openUntil(_ event: Event) -> String? {
        guard event.areUploadsOpen, event.archivedAt == nil, let closesAt = event.effectiveUploadsCloseAt else { return nil }
        return closesAt.formatted(date: .abbreviated, time: .shortened)
    }
}
