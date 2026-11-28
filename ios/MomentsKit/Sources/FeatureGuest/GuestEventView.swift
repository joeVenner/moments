import CoreGraphics
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
    /// A batch was just queued: the uploads list opens once the picker closes.
    @State private var showsProgressAfterSharing = false
    @State private var isConfirmingLeave = false
    @State private var isShowingMutedGuests = false
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
                    GuestEventHeader(
                        event: feed.event, stats: feed.stats, myEntry: leaderboard.myEntry, images: thumbnails, section: $section
                    )
                        // The buttons sit on the banner, as on the website.
                        .overlay(alignment: .top) {
                            if leave != nil || progress != nil || onHome != nil { topBar }
                        }
                        // New moments change points too; the board waits 30 s between loads.
                        .task(id: feed.stats) { await leaderboard.loadIfStale() }
                    if let progress, progress.activeCount > 0 || progress.failedCount > 0 {
                        UploadStrip(model: progress) { isShowingProgress = true }
                            .padding(.horizontal, Spacing.md)
                            .padding(.bottom, Spacing.sm)
                            .transition(.opacity)
                    }
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
            // Straight to the uploads list, so each one's progress shows live.
            if showsProgressAfterSharing, progress != nil { isShowingProgress = true }
            showsProgressAfterSharing = false
        }) { model in
            UploadView(model: model) {
                sharedBatches += 1
                showsProgressAfterSharing = true
            }
            .momentsButtonDefaults()
        }
        // Follows the queue while the event is shown, so counts and bars are live.
        .task(id: progress.map(ObjectIdentifier.init)) { await progress?.observe() }
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
            Task { await VideoPosterLoader.shared.removeAll() }
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
                slug: join.slug, participantID: participant.id,
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
        // VoiceOver hears uploads start and finish, as in the App Clip. Not
        // while leaving: that drops queued items, which were never sent.
        .onChange(of: progress?.sendingSnapshot) { old, new in
            guard let old, let new, (leave?.phase ?? .idle) == .idle,
                  let announcement = SendingAnnouncement.change(from: old, to: new) else { return }
            AccessibilityNotification.Announcement(announcement.message).post()
        }
        .onChange(of: leave?.phase) { _, phase in
            guard phase == .left else { return }
            upload?.discardAll()
            upload = nil
            highlights?.end()
            leaderboard?.end()
            for loader in [thumbnails, viewerImages].compactMap(\.self) { Task { await loader.removeAll() } }
            Task { await VideoPosterLoader.shared.removeAll() }
            onLeft()
        }
    }

    // MARK: - Leaving

    private var topBar: some View {
        HStack(spacing: 0) {
            if let onHome { homeButton(onHome) }
            Spacer()
            if let progress { uploadsButton(progress) }
            if let leave, let leaderboard { eventMenu(leave, leaderboard: leaderboard) }
        }
        .padding(.horizontal, Spacing.xs)
        .padding(.top, Spacing.xxs)
    }

    private func homeButton(_ action: @escaping () -> Void) -> some View {
        Button(action: action) { BannerIcon(systemName: "chevron.backward") }
            .accessibilityLabel(Text("Home"))
    }

    /// Opens "Your uploads"; a count while some are under way, and a mark
    /// when one needs attention.
    private func uploadsButton(_ progress: UploadProgressModel) -> some View {
        Button { isShowingProgress = true } label: {
            BannerIcon(
                systemName: progress.failedCount > 0 ? "exclamationmark.arrow.circlepath" : "arrow.up",
                count: progress.activeCount > 0 ? progress.activeCount : nil,
                isHighlighted: progress.failedCount > 0
            )
        }
        .accessibilityLabel(Text("Your uploads"))
        .accessibilityValue(Text(uploadsSummary(progress)))
        .sheet(isPresented: $isShowingProgress) { UploadProgressView(model: progress, eventTitle: feed?.event.title).momentsButtonDefaults() }
    }

    private func uploadsSummary(_ progress: UploadProgressModel) -> String {
        var parts: [String] = []
        if progress.activeCount > 0 { parts.append(String(localized: "\(progress.activeCount) in progress")) }
        if progress.failedCount > 0 { parts.append(String(localized: "\(progress.failedCount) need attention")) }
        return parts.joined(separator: ", ")
    }

    private func eventMenu(_ leave: LeaveModel, leaderboard: LeaderboardModel) -> some View {
        HStack {
            Menu {
                Button("Muted guests", systemImage: "speaker.slash") { isShowingMutedGuests = true }
                Button("Leave event…", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                    isConfirmingLeave = true
                }
            } label: {
                BannerIcon(systemName: "ellipsis")
            }
            // Menus ignore the default style; plain keeps Button Shapes off the label.
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Event options"))
            .disabled(leave.phase == .leaving)
        }
        // Unmuted guests' moments come back right away.
        .sheet(isPresented: $isShowingMutedGuests, onDismiss: {
            feed?.reloadHidden()
            highlights?.reloadHidden()
        }) {
            MutedGuestsView(model: leaderboard).momentsButtonDefaults()
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
            Text(failure.message)
        }
    }

    private func leaveFailure(_ leave: LeaveModel) -> LeaveModel.Failure? {
        if case let .failed(failure) = leave.phase { failure } else { nil }
    }

    /// Shown under Moments and Highlights (insetting their content) when
    /// uploads are available and the event takes them.
    @ViewBuilder private func shareButton(_ feed: FeedModel) -> some View {
        if let uploads = dependencies.uploads, !feed.hasEnded, feed.event.acceptsUploads {
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

/// A round icon button drawn on the event banner: a 36 pt disc inside a
/// 44 pt tap target.
struct BannerIcon: View {
    let systemName: String
    /// Shown beside the icon (uploads under way).
    var count: Int?
    var isHighlighted = false

    var body: some View {
        HStack(spacing: Spacing.xxs) {
            Image(systemName: systemName)
                .font(.system(size: 15, weight: .semibold))
            if let count {
                Text(count, format: .number)
                    .font(MomentsFont.number(.footnote))
            }
        }
        .foregroundStyle(isHighlighted ? MomentsColor.accent : MomentsColor.text)
        .padding(.horizontal, count == nil ? 0 : Spacing.sm)
        .frame(minWidth: 36, minHeight: 36)
        .background(MomentsColor.background.opacity(0.55), in: Capsule())
        .frame(minWidth: Radius.minimumTapTarget, minHeight: Radius.minimumTapTarget)
        .contentShape(Rectangle())
    }
}

/// Uploads under way, above the feed: how far the batch is; opens the list
/// with each item's own progress.
struct UploadStrip: View {
    let model: UploadProgressModel
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: Spacing.sm) {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text(UploadQueueHeader.title(model.headline))
                        .font(MomentsFont.caption().weight(.semibold))
                        .foregroundStyle(model.activeCount > 0 ? MomentsColor.text : MomentsColor.accent)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if model.activeCount > 0 {
                        ProgressView(value: model.overallFraction)
                            .tint(MomentsColor.accent)
                    }
                }
                if model.activeCount > 0 {
                    Text(model.overallFraction, format: .percent.precision(.fractionLength(0)))
                        .font(MomentsFont.number(.footnote))
                        .foregroundStyle(MomentsColor.textMuted)
                }
                Image(systemName: "chevron.forward")
                    .font(MomentsFont.caption().weight(.semibold))
                    .foregroundStyle(MomentsColor.textMuted)
            }
            .padding(.horizontal, Spacing.sm)
            .padding(.vertical, Spacing.xs)
            .frame(minHeight: Radius.minimumTapTarget)
            .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).stroke(MomentsColor.border))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(UploadQueueHeader.title(model.headline)))
        .accessibilityValue(model.activeCount > 0 ? Text(model.overallFraction, format: .percent.precision(.fractionLength(0))) : Text(verbatim: ""))
        .accessibilityHint(Text("Shows your uploads"))
    }
}

/// The event's banner (its cover photo, or a scene for its type) with the
/// name on it, then the counts and the section switcher.
struct GuestEventHeader: View {
    let event: Event
    /// The counts; nil (an older server) keeps the sharing line alone.
    var stats: EventStats?
    /// The guest's leaderboard entry, for the points pill; nil hides it.
    var myEntry: LeaderboardEntry?
    /// Loads the cover photo (with the private-event grant); nil shows the scene.
    var images: ThumbnailLoader?
    @Binding var section: GuestEventSection
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var cover: CGImage?

    /// Tall enough for the buttons above a one-line title.
    private static let bannerMinHeight: CGFloat = 168
    private static let coverPixelSize = 1320

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            banner
            VStack(alignment: .leading, spacing: Spacing.sm) {
                // Large text: the counts need the width, so the pill goes below.
                let layout = typeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.sm))
                    : AnyLayout(HStackLayout(alignment: .center, spacing: Spacing.sm))
                layout {
                    statsBlock
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let myEntry { pointsPill(myEntry) }
                }
                sectionPicker
            }
            .padding(.horizontal, Spacing.md)
        }
        .padding(.bottom, Spacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: event.coverImageURL) { await loadCover() }
    }

    private var banner: some View {
        titleBlock
            .padding(.horizontal, Spacing.md)
            .padding(.bottom, Spacing.sm)
            // Clear of the buttons drawn over the banner's top.
            .padding(.top, Radius.minimumTapTarget + Spacing.sm)
            .frame(maxWidth: .infinity, minHeight: Self.bannerMinHeight, alignment: .bottomLeading)
            .background {
                ZStack {
                    if let cover {
                        Color.clear.overlay {
                            Image(decorative: cover, scale: 1)
                                .resizable()
                                .scaledToFill()
                        }
                    } else {
                        EventBannerScene(type: event.type)
                    }
                    // Keeps the name readable over any photo.
                    LinearGradient(
                        stops: [
                            .init(color: MomentsColor.background.opacity(0.35), location: 0),
                            .init(color: MomentsColor.background.opacity(0.1), location: 0.35),
                            .init(color: MomentsColor.background.opacity(0.92), location: 1),
                        ],
                        startPoint: .top, endPoint: .bottom
                    )
                }
                .clipped()
                .ignoresSafeArea(edges: .top)
            }
    }

    private func loadCover() async {
        guard let images, let url = event.coverImageURL.flatMap(URL.init(string:)) else {
            cover = nil
            return
        }
        // A cover that can't load leaves the scene: nothing to report.
        cover = try? await images.image(at: url, maxPixelSize: Self.coverPixelSize)
    }

    /// "128 moments", "46 guests", then when sharing closes.
    @ViewBuilder private var statsBlock: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            if let stats {
                HStack(spacing: Spacing.md) {
                    stat(String(localized: "\(stats.momentCount) moments"), systemImage: "photo.on.rectangle")
                    stat(String(localized: "\(stats.guestCount) guests"), systemImage: "person.2")
                }
            }
            if let line = Self.sharingLine(event) {
                Text(line)
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .ignore)
        // VoiceOver would read the separators as "dot".
        .accessibilityLabel(Text(verbatim: (Self.headerLine(event, stats: stats) ?? "").replacingOccurrences(of: " · ", with: ", ")))
    }

    private func stat(_ text: String, systemImage: String) -> some View {
        HStack(spacing: Spacing.xxs) {
            Image(systemName: systemImage)
                .foregroundStyle(MomentsColor.accent)
            Text(verbatim: text)
                .foregroundStyle(MomentsColor.text)
        }
        .font(MomentsFont.caption().weight(.semibold))
        .lineLimit(1)
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

    /// The type in the accent colour, the name, and who it is about.
    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            if let type = Self.typeLabel(event) {
                type
                    .font(MomentsFont.caption(.caption).weight(.semibold))
                    .textCase(.uppercase)
                    .kerning(1.2)
                    .foregroundStyle(MomentsColor.accent)
            }
            Text(verbatim: event.title)
                .font(MomentsFont.display(.title))
                .foregroundStyle(MomentsColor.text)
                .accessibilityAddTraits(.isHeader)
                .fixedSize(horizontal: false, vertical: true)
            if let people = event.mainCharacters?.trimmingCharacters(in: .whitespacesAndNewlines), !people.isEmpty {
                Text(verbatim: people)
                    .font(MomentsFont.body(.subheadline))
                    .foregroundStyle(MomentsColor.textMuted)
                    .lineLimit(2)
            }
        }
    }

    /// A known type in the guest's language, a custom one as the host wrote
    /// it, nil when the event has none.
    static func typeLabel(_ event: Event) -> Text? {
        switch JoinEventLine(event).kind {
        case let .preset(preset): Text(LocalizedStringKey(preset.storedValue))
        case let .custom(written): Text(verbatim: written)
        case .none: nil
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
        guard event.acceptsUploads, let closesAt = event.effectiveUploadsCloseAt else { return nil }
        return closesAt.formatted(date: .abbreviated, time: .shortened)
    }
}
