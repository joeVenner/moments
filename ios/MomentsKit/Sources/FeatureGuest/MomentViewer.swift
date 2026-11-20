#if os(iOS)
import AVFoundation
import AVKit
import Combine
import CoreGraphics
import DesignSystem
import MomentsDomain
import OSLog
import SwiftUI

/// Which moment the feed opened, for `fullScreenCover(item:)`.
struct ViewerRequest: Identifiable, Equatable {
    let id: Moment.ID
}

/// Full-screen moments: swipe sideways between them, pinch to zoom,
/// double-tap to heart (or to zoom back out), swipe down to close. Videos
/// play inline.
///
/// The viewer owns its position; the feed's request only presents it, so
/// closing never blanks the page while the cover animates away.
struct MomentViewer: View {
    let model: any MomentBrowsing
    let images: ThumbnailLoader
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var current: Moment.ID?
    @State private var isZoomed = false
    @State private var isPlaying = false
    @State private var dismissDrag: CGFloat = 0
    @State private var showsChrome = true
    /// Bumped by every heart tap, for the haptic.
    @State private var heartTaps = 0
    /// The report question, while it's asked.
    @State private var reportQuestion: ReportQuestion?
    @State private var isReporting = false
    /// Shown briefly after a report.
    @State private var reportMessage: LocalizedStringResource?
    @State private var reportMessageTask: Task<Void, Never>?
    @State private var reportTask: Task<Void, Never>?

    init(model: any MomentBrowsing, images: ThumbnailLoader, start: Moment.ID) {
        self.model = model
        self.images = images
        _current = State(initialValue: start)
    }

    var body: some View {
        let moments = model.moments
        let index = moments.firstIndex { $0.id == current }
        ScrollViewReader { proxy in
            ZStack {
                MomentsColor.background
                    .opacity(ViewerGestures.backgroundOpacity(forDrag: dismissDrag))
                    .ignoresSafeArea()
                ScrollView(.horizontal) {
                    // Lazy: only pages near the screen exist (and hold images).
                    LazyHStack(spacing: 0) {
                        ForEach(moments) { moment in
                            ViewerPage(
                                moment: moment, images: images, isCurrent: moment.id == current,
                                isZoomed: $isZoomed, isPlaying: $isPlaying, dismissDrag: $dismissDrag,
                                close: close, toggleChrome: { showsChrome.toggle() },
                                heart: { heart(moment) }, toggleReaction: { toggleReaction(moment) }
                            )
                            .containerRelativeFrame([.horizontal, .vertical])
                            .id(moment.id)
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.paging)
                .scrollPosition(id: $current)
                // A zoomed photo pans instead of paging.
                .scrollDisabled(isZoomed)
                .scrollIndicators(.hidden)
                .ignoresSafeArea()
                // A playing video takes taps for its own controls, so Close stays
                // up while it plays; the rest of the chrome steps aside.
                if (showsChrome || isPlaying), let index {
                    chrome(moment: moments[index], position: index + 1, total: moments.count, isPlaying: isPlaying)
                        .transition(.opacity)
                }
                if let reportMessage {
                    reportBanner(reportMessage)
                        .transition(.opacity)
                }
            }
            // `scrollPosition` alone can open on the first page on iOS 17.
            .onAppear { if let current { proxy.scrollTo(current) } }
        }
        .momentsAnimation(value: showsChrome)
        .momentsAnimation(value: reportMessage == nil)
        // One dialog for report and mute (dialogs are never chained).
        .confirmationDialog(
            Text("Report this moment?"),
            isPresented: Binding { reportQuestion != nil } set: { if !$0 { reportQuestion = nil } },
            titleVisibility: .visible,
            presenting: reportQuestion
        ) { question in
            Button("Report", role: .destructive) { report(question.momentID) }
            if let participantID = question.muteParticipantID {
                Button("Mute \(question.uploaderName)") { mute(participantID, name: question.uploaderName) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { question in
            if question.muteParticipantID == nil {
                Text("The host will review it.")
            } else {
                Text("The host will review a report. Muting hides \(question.uploaderName)'s moments on this phone.")
            }
        }
        .onDisappear {
            reportTask?.cancel()
            reportMessageTask?.cancel()
        }
        .statusBarHidden(!showsChrome)
        .sensoryFeedback(.impact(weight: .light), trigger: heartTaps)
        .sensoryFeedback(.error, trigger: model.reactionFailureCount)
        .onChange(of: current) { _, id in
            isZoomed = false
            isPlaying = false
            // Paging toward the end keeps older moments coming.
            if let moment = moments.first(where: { $0.id == id }) { model.momentShown(moment) }
        }
        // The moment on screen was hidden or deleted, or access ended.
        .onChange(of: index == nil) { _, isGone in if isGone { close() } }
        // Access lost or the event deleted.
        .onChange(of: model.isBrowsable) { _, browsable in if !browsable { close() } }
    }

    private func close() {
        dismiss()
    }

    /// Double-tap: only ever adds a heart, like other photo apps.
    private func heart(_ moment: Moment) {
        heartTaps += 1
        model.setReacted(true, onMomentID: moment.id)
    }

    private func toggleReaction(_ moment: Moment) {
        heartTaps += 1
        model.toggleReaction(onMomentID: moment.id)
    }

    private func report(_ id: Moment.ID) {
        guard !isReporting else { return }
        isReporting = true
        reportTask = Task {
            let outcome = await model.report(momentID: id)
            isReporting = false
            guard let message = outcome.message else { return }
            show(message)
        }
    }

    private func mute(_ participantID: String, name: String) {
        if model.mute(participantID: participantID) {
            show("You won't see \(name)'s moments on this phone. Unmute them from the event menu.")
        } else {
            show("\(name)'s moments are hidden for now, but this phone couldn't save it.")
        }
    }

    private func show(_ message: LocalizedStringResource) {
        reportMessage = message
        AccessibilityNotification.Announcement(String(localized: message)).post()
        reportMessageTask?.cancel()
        reportMessageTask = Task {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            reportMessage = nil
        }
    }

    private func reportBanner(_ message: LocalizedStringResource) -> some View {
        // Under the Close row, clear of the bottom bar at any text size.
        VStack {
            Text(message)
                .font(MomentsFont.body(.subheadline))
                .foregroundStyle(MomentsColor.text)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Spacing.md)
                .padding(.vertical, Spacing.sm)
                .background(MomentsColor.surface, in: Capsule())
                .overlay(Capsule().stroke(MomentsColor.border))
                .padding(.horizontal, Spacing.md)
                .padding(.top, Radius.minimumTapTarget + Spacing.lg)
            Spacer()
        }
        .allowsHitTesting(false)
        // Announced when shown.
        .accessibilityHidden(true)
    }

    private func reportButton(_ moment: Moment) -> some View {
        let question = ReportQuestion(moment, canMute: model.canMute(moment))
        return Button { reportQuestion = question } label: {
            Image(systemName: "flag")
                .font(MomentsFont.body().weight(.semibold))
                .foregroundStyle(MomentsColor.text)
                .frame(width: Radius.minimumTapTarget, height: Radius.minimumTapTarget)
                .background(MomentsColor.surface.opacity(0.85), in: Circle())
                .overlay(Circle().stroke(MomentsColor.border))
        }
        .disabled(isReporting)
        .accessibilityLabel(question.muteParticipantID == nil ? Text("Report") : Text("Report or mute"))
    }

    private func chrome(moment: Moment, position: Int, total: Int, isPlaying: Bool) -> some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(MomentsFont.body().weight(.semibold))
                        .foregroundStyle(MomentsColor.text)
                        .frame(width: Radius.minimumTapTarget, height: Radius.minimumTapTarget)
                        .background(MomentsColor.background.opacity(0.6), in: Circle())
                }
                .accessibilityLabel(Text("Close"))
                if !isPlaying { uploader(moment) }
                Spacer(minLength: Spacing.sm)
                if !isPlaying { counter(position: position, total: total) }
            }
            .padding(.horizontal, Spacing.md)
            .padding(.bottom, Spacing.lg)
            // Keeps the name readable over a bright photo, like the bottom.
            .background {
                if !isPlaying {
                    LinearGradient(
                        colors: [MomentsColor.background.opacity(0.7), MomentsColor.background.opacity(0)],
                        startPoint: .top, endPoint: .bottom
                    )
                    .ignoresSafeArea(edges: .top)
                }
            }
            Spacer()
            if !isPlaying {
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    caption(moment)
                    HStack(spacing: Spacing.sm) {
                        reactionButton(moment)
                        Spacer(minLength: 0)
                        reportButton(moment)
                        shareButton(moment)
                    }
                }
                .padding(Spacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    LinearGradient(
                        colors: [MomentsColor.background.opacity(0), MomentsColor.background.opacity(0.85)],
                        startPoint: .top, endPoint: .bottom
                    )
                    .ignoresSafeArea(edges: .bottom)
                )
            }
        }
    }

    private func reactionButton(_ moment: Moment) -> some View {
        Button { toggleReaction(moment) } label: {
            HStack(spacing: Spacing.xs) {
                Image(systemName: moment.hasReacted ? "heart.fill" : "heart")
                    .font(MomentsFont.body().weight(.semibold))
                    .foregroundStyle(moment.hasReacted ? MomentsColor.accent : MomentsColor.text)
                    .contentTransition(.symbolEffect(.replace))
                    .animation(Motion.animation(Motion.standard, reduceMotion: reduceMotion), value: moment.hasReacted)
                Text(moment.reactionCount, format: .number)
                    .font(MomentsFont.number(.body))
                    .foregroundStyle(MomentsColor.text)
            }
            .padding(.horizontal, Spacing.md)
            .frame(minWidth: Radius.minimumTapTarget, minHeight: Radius.minimumTapTarget)
            .background(MomentsColor.surface.opacity(0.85), in: Capsule())
            .overlay(Capsule().stroke(moment.hasReacted ? MomentsColor.accent : MomentsColor.border))
        }
        .accessibilityLabel(Text("Heart"))
        .accessibilityValue(Text(moment.hasReacted ? "On, ^[\(moment.reactionCount) heart](inflect: true)" : "Off, ^[\(moment.reactionCount) heart](inflect: true)"))
        .accessibilityAddTraits(.isToggle)
    }

    /// Photos only for now: a video would need its whole file downloaded.
    @ViewBuilder private func shareButton(_ moment: Moment) -> some View {
        if let photo = SharedPhoto(media: moment.media, images: images) {
            // The preview names no one: it shows in other apps.
            ShareLink(item: photo, preview: SharePreview(Text("Photo"))) {
                Image(systemName: "square.and.arrow.up")
                    .font(MomentsFont.body().weight(.semibold))
                    .foregroundStyle(MomentsColor.text)
                    .frame(width: Radius.minimumTapTarget, height: Radius.minimumTapTarget)
                    .background(MomentsColor.surface.opacity(0.85), in: Circle())
                    .overlay(Circle().stroke(MomentsColor.border))
            }
            .fixedSize()
            .accessibilityLabel(Text("Share photo"))
        }
    }

    private func counter(position: Int, total: Int) -> some View {
            Text("\(position) of \(total)")
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.text)
                .padding(.horizontal, Spacing.sm)
                .padding(.vertical, Spacing.xxs)
                .background(MomentsColor.background.opacity(0.6), in: Capsule())
                .lineLimit(1)
                .fixedSize()
                .accessibilityLabel(Text("Moment \(position) of \(total)"))
    }

    /// Who shared it and how long ago, beside Close.
    private func uploader(_ moment: Moment) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: moment.uploaderName)
                .font(MomentsFont.body(.subheadline).bold())
                .foregroundStyle(MomentsColor.text)
                .lineLimit(1)
            // A server clock ahead of this phone would read "in 2 minutes".
            Text(min(moment.createdAt, .now), format: .relative(presentation: .named))
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.textMuted)
                .lineLimit(1)
        }
        // The name gives way first when space runs out.
        .layoutPriority(-1)
        // The page already reads the uploader.
        .accessibilityHidden(true)
    }

    @ViewBuilder private func caption(_ moment: Moment) -> some View {
        if let caption = moment.caption, !caption.isEmpty {
            Text(verbatim: caption)
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.text)
                .lineLimit(4)
                // The page already reads the caption.
                .accessibilityHidden(true)
        }
    }
}

/// One moment: a zoomable photo, or a video with its poster until it plays.
private struct ViewerPage: View {
    let moment: Moment
    let images: ThumbnailLoader
    let isCurrent: Bool
    @Binding var isZoomed: Bool
    @Binding var isPlaying: Bool
    @Binding var dismissDrag: CGFloat
    let close: () -> Void
    let toggleChrome: () -> Void
    /// Double-tap on an unzoomed page.
    let heart: () -> Void
    let toggleReaction: () -> Void

    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var image: CGImage?
    @State private var failed = false
    @State private var scale: CGFloat = 1
    @State private var baseScale: CGFloat = 1
    @State private var pan: CGSize = .zero
    @State private var basePan: CGSize = .zero
    @State private var player: AVPlayer?
    @State private var videoFailed = false
    /// Bumped by each double-tap heart; each bump replays the burst.
    @State private var bursts = 0

    private static let burstHeartSize: CGFloat = 96

    /// The largest viewer image decoded, whatever the screen.
    private static let maxPixelSize = 2400
    private static let playButtonSize: CGFloat = 72
    private static let logger = Logger(subsystem: "moments", category: "viewer")

    private var isPhoto: Bool { moment.media.kind == .image }

    var body: some View {
        GeometryReader { geometry in
            content
                .frame(width: geometry.size.width, height: geometry.size.height)
                .overlay { heartBurst }
                .scaleEffect(scale)
                .offset(x: pan.width, y: pan.height + (isCurrent ? max(0, dismissDrag) : 0))
                .contentShape(Rectangle())
                .onTapGesture(count: 2, perform: doubleTap)
                .onTapGesture(count: 1, perform: toggleChrome)
                .gesture(magnify(in: geometry.size), isEnabled: isPhoto)
                .simultaneousGesture(drag(in: geometry.size), isEnabled: player == nil)
                .task(id: moment.id) { await loadImage(pixelSize: pixelSize(for: geometry.size)) }
                // Cancelled with the player or the page, so it never outlives either.
                .task(id: player.map(ObjectIdentifier.init)) { await watchPlayback() }
                .accessibilityAction(named: Text("Zoom in")) { if isPhoto, scale == 1 { toggleZoom(in: geometry.size) } }
                .accessibilityAction(named: Text("Zoom out")) { if scale > 1 { resetZoom() } }
                .accessibilityAction(named: Text(moment.hasReacted ? "Remove heart" : "Heart"), toggleReaction)
        }
        .onChange(of: isCurrent) { _, current in
            if !current {
                resetZoom()
                releasePlayer()
            }
        }
        .onDisappear(perform: releasePlayer)
        .accessibilityElement(children: isPhoto ? .ignore : .contain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(isPhoto ? .isImage : [])
        .accessibilityHidden(!isCurrent)
        .accessibilityAction(.escape, close)
        .accessibilityAction(named: Text("Close"), close)
    }

    @ViewBuilder private var content: some View {
        if let player {
            VideoPlayer(player: player)
        } else if let image {
            Image(decorative: image, scale: 1)
                .resizable()
                .scaledToFit()
                .overlay { if !isPhoto { videoOverlay } }
        } else if failed {
            message("Couldn't load this moment.", systemImage: "photo")
        } else {
            ProgressView().tint(MomentsColor.textMuted)
        }
    }

    @ViewBuilder private var videoOverlay: some View {
        if videoFailed {
            message("This video can't play right now.", systemImage: "exclamationmark.triangle")
        } else if moment.media.playbackURL == nil {
            message("This video isn't ready yet.", systemImage: "hourglass")
        } else {
            Button(action: play) {
                Image(systemName: "play.fill")
                    .font(MomentsFont.display(.title))
                    .foregroundStyle(MomentsColor.text)
                    .frame(width: Self.playButtonSize, height: Self.playButtonSize)
                    .background(MomentsColor.background.opacity(0.6), in: Circle())
            }
            .accessibilityLabel(Text("Play video"))
        }
    }

    private func message(_ text: LocalizedStringKey, systemImage: String) -> some View {
        VStack(spacing: Spacing.sm) {
            Image(systemName: systemImage).font(MomentsFont.display())
            Text(text).font(MomentsFont.body())
        }
        .foregroundStyle(MomentsColor.textMuted)
        .padding(Spacing.md)
        .background(MomentsColor.background.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.card))
    }

    private func magnify(in size: CGSize) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                scale = ViewerGestures.clampedScale(baseScale * value.magnification)
                pan = ViewerGestures.clampedPan(pan, scale: scale, in: size)
                // Lock paging as soon as the photo grows, not when fingers lift.
                if scale > ViewerGestures.minimumScale, !isZoomed { isZoomed = true }
            }
            .onEnded { _ in
                baseScale = scale
                basePan = pan
                if scale <= ViewerGestures.minimumScale { resetZoom() } else { isZoomed = true }
            }
    }

    /// Pans a zoomed photo; otherwise a downward drag closes the viewer.
    private func drag(in size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                if scale > ViewerGestures.minimumScale {
                    let proposed = CGSize(
                        width: basePan.width + value.translation.width, height: basePan.height + value.translation.height
                    )
                    pan = ViewerGestures.clampedPan(proposed, scale: scale, in: size)
                } else if value.translation.height > abs(value.translation.width) {
                    dismissDrag = value.translation.height
                }
            }
            .onEnded { value in
                if scale > ViewerGestures.minimumScale {
                    basePan = pan
                    return
                }
                let closes = ViewerGestures.shouldDismiss(
                    translation: value.translation, predictedEnd: value.predictedEndTranslation, scale: scale
                )
                // Closing keeps the dragged offset: the cover slides away from there.
                if closes {
                    close()
                } else {
                    withAnimation(Motion.animation(Motion.standard, reduceMotion: reduceMotion)) { dismissDrag = 0 }
                }
            }
    }

    /// Zoomed: back to fit. Otherwise: heart it, with a burst.
    private func doubleTap() {
        if scale > ViewerGestures.minimumScale {
            withAnimation(Motion.animation(Motion.standard, reduceMotion: reduceMotion)) { resetZoom() }
            return
        }
        heart()
        bursts += 1
    }

    /// A big heart that pops in and out; under Reduce Motion it only
    /// appears and fades, without growing.
    private var heartBurst: some View {
        let grows = !reduceMotion
        return Image(systemName: "heart.fill")
            .font(.system(size: Self.burstHeartSize))
            .foregroundStyle(MomentsColor.accent)
            .shadow(color: MomentsColor.background.opacity(0.4), radius: 8)
            .keyframeAnimator(initialValue: BurstFrame(), trigger: bursts) { heart, frame in
                heart.scaleEffect(frame.scale).opacity(frame.opacity)
            } keyframes: { _ in
                KeyframeTrack(\.scale) {
                    if grows {
                        LinearKeyframe(0.4, duration: 0.01)
                        SpringKeyframe(1, duration: 0.3, spring: .bouncy)
                    } else {
                        LinearKeyframe(1, duration: 0.01)
                    }
                }
                KeyframeTrack(\.opacity) {
                    LinearKeyframe(1, duration: 0.01)
                    LinearKeyframe(1, duration: 0.5)
                    LinearKeyframe(0, duration: 0.15)
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    private func toggleZoom(in size: CGSize) {
        guard isPhoto else { return }
        withAnimation(Motion.animation(Motion.standard, reduceMotion: reduceMotion)) {
            scale = ViewerGestures.scaleAfterDoubleTap(from: scale)
            baseScale = scale
            pan = ViewerGestures.clampedPan(pan, scale: scale, in: size)
            basePan = pan
        }
        isZoomed = scale > ViewerGestures.minimumScale
    }

    private func resetZoom() {
        scale = 1
        baseScale = 1
        pan = .zero
        basePan = .zero
        if isCurrent { isZoomed = false }
    }

    private func play() {
        guard let url = moment.media.playbackURL.flatMap(URL.init(string:)) else { return }
        do {
            // Plays with sound even when the ring switch is on silent.
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            Self.logger.error("audio session failed: \(String(describing: error), privacy: .public)")
        }
        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        self.player = player
        isPlaying = true
        player.play()
    }

    /// Back to the poster when the video ends; a message when it can't play
    /// (expired link, unplayable file, failure mid-stream).
    private func watchPlayback() async {
        guard let item = player?.currentItem else { return }
        let failedToLoad = item.publisher(for: \.status).filter { $0 == .failed }.map { _ in true }
        let failedMidway = NotificationCenter.default
            .publisher(for: AVPlayerItem.failedToPlayToEndTimeNotification, object: item).map { _ in true }
        let finished = NotificationCenter.default
            .publisher(for: AVPlayerItem.didPlayToEndTimeNotification, object: item).map { _ in false }
        for await didFail in failedToLoad.merge(with: failedMidway, finished).values {
            if didFail { Self.logger.error("video playback failed") }
            releasePlayer()
            videoFailed = didFail
            return
        }
    }

    /// Frees the player (and its buffers) and lets other apps' audio resume.
    private func releasePlayer() {
        guard let player else { return }
        player.pause()
        player.replaceCurrentItem(with: nil)
        self.player = nil
        if isCurrent { isPlaying = false }
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            // Often "busy" right after pausing; harmless.
            Self.logger.debug("audio session release failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func pixelSize(for size: CGSize) -> Int {
        let longest = max(size.width, size.height) * displayScale
        return min(Self.maxPixelSize, max(1, Int(longest.rounded(.up))))
    }

    private func loadImage(pixelSize: Int) async {
        guard image == nil else { return }
        guard let url = moment.media.viewerImageURL.flatMap(URL.init(string:)) else {
            failed = true
            return
        }
        failed = false
        do {
            image = try await images.image(at: url, maxPixelSize: pixelSize)
        } catch is CancellationError {
            return
        } catch {
            failed = true
        }
    }

    private var accessibilityLabel: Text {
        let name = moment.uploaderName
        let caption = moment.caption.flatMap { $0.isEmpty ? nil : $0 }
        switch (isPhoto, caption) {
        case (false, nil): return Text("Video by \(name)")
        case (true, nil): return Text("Photo by \(name)")
        case let (false, caption?): return Text("Video by \(name): \(caption)")
        case let (true, caption?): return Text("Photo by \(name): \(caption)")
        }
    }
}
/// The burst's animated values; at rest it is invisible.
private struct BurstFrame {
    var scale: CGFloat = 1
    var opacity: Double = 0
}
#endif
