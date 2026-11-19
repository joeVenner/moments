import DesignSystem
import MomentsDomain
import SwiftUI

/// Guests ranked by points: a podium for the first three, then the rest.
/// This guest is marked; reaching the podium sets off confetti (not under
/// Reduce Motion).
public struct LeaderboardView: View {
    let model: LeaderboardModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var confettiBursts = 0
    /// Podium arrivals already celebrated (or skipped); one that lands while
    /// another tab is showing plays when this one comes back.
    @State private var celebrated = 0
    @State private var isVisible = false
    @ScaledMetric(relativeTo: .body) private var rowAvatarSize: CGFloat = 36
    @ScaledMetric(relativeTo: .body) private var rankWidth: CGFloat = 28

    public init(model: LeaderboardModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                Text("Leaderboard")
                    .font(MomentsFont.display(.title))
                    .foregroundStyle(MomentsColor.text)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.horizontal, Spacing.md)
                content
            }
            .padding(.vertical, Spacing.md)
        }
        .refreshable { await model.refresh() }
        .background(MomentsColor.background)
        .onAppear {
            isVisible = true
            celebrateIfDue()
            Task { await model.loadIfStale() }
        }
        .onDisappear { isVisible = false }
        #if os(iOS)
        .overlay { ConfettiView(bursts: confettiBursts).allowsHitTesting(false).accessibilityHidden(true) }
        #endif
        .onChange(of: model.podiumCelebrations) { _, _ in celebrateIfDue() }
    }

    private func celebrateIfDue() {
        guard isVisible, model.podiumCelebrations > celebrated else { return }
        celebrated = model.podiumCelebrations
        if Motion.shouldCelebrate(reduceMotion: reduceMotion) { confettiBursts += 1 }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView()
                .tint(MomentsColor.textMuted)
                .frame(maxWidth: .infinity, minHeight: 200)
                .accessibilityLabel(Text("Loading the leaderboard"))
        case .failed:
            GuestMessage(title: "Can't reach Moments", detail: "Check your connection and try again.")
            Button("Try again") { Task { await model.refresh() } }
                .buttonStyle(.momentsPrimary)
                .padding(.horizontal, Spacing.md)
        case .loaded where model.entries.isEmpty:
            GuestMessage(title: "No guests yet", detail: "Share moments to earn points and climb the board.")
        case .loaded:
            podium
            LazyVStack(spacing: Spacing.xs) {
                ForEach(model.others) { entry in
                    row(entry)
                }
            }
            .padding(.horizontal, Spacing.md)
        }
    }

    /// Laid out second, first, third; read first, second, third.
    private var podium: some View {
        let places = Array(model.podium)
        let order = [1, 0, 2].filter { $0 < places.count }
        return HStack(alignment: .bottom, spacing: Spacing.sm) {
            ForEach(order, id: \.self) { position in
                PodiumPlace(entry: places[position], position: position, isMe: places[position].participantID == model.participantID)
                    .accessibilitySortPriority(Double(LeaderboardModel.podiumSize - position))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Spacing.md)
        .accessibilityElement(children: .contain)
    }

    private func row(_ entry: LeaderboardEntry) -> some View {
        let isMe = entry.participantID == model.participantID
        return HStack(spacing: Spacing.sm) {
            Text(verbatim: "\(entry.rank)")
                .font(MomentsFont.number(.body))
                .foregroundStyle(MomentsColor.textMuted)
                .frame(minWidth: rankWidth, alignment: .leading)
            GuestAvatar(nickname: entry.nickname, seed: entry.avatarSeed, size: rowAvatarSize)
            Text(verbatim: entry.nickname)
                .font(MomentsFont.body().weight(isMe ? .semibold : .regular))
                .foregroundStyle(MomentsColor.text)
                .lineLimit(1)
            if isMe { YouBadge() }
            Spacer()
            Text("^[\(entry.totalPoints) point](inflect: true)")
                .font(MomentsFont.number(.subheadline))
                .foregroundStyle(MomentsColor.text)
        }
        .padding(Spacing.sm)
        .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay {
            if isMe { RoundedRectangle(cornerRadius: Radius.control).stroke(MomentsColor.accent, lineWidth: 1.5) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(LeaderboardLabels.entry(entry, isMe: isMe))
    }
}

private struct PodiumPlace: View {
    let entry: LeaderboardEntry
    /// 0 for first place.
    let position: Int
    let isMe: Bool
    /// Scales the podium with Dynamic Type.
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    private static let stepHeights: [CGFloat] = [96, 72, 56]
    private static let avatarSizes: [CGFloat] = [64, 52, 52]

    var body: some View {
        VStack(spacing: Spacing.xs) {
            GuestAvatar(nickname: entry.nickname, seed: entry.avatarSeed, size: Self.avatarSizes[position] * scale)
                .overlay { if isMe { Circle().stroke(MomentsColor.accent, lineWidth: 2) } }
            Text(verbatim: entry.nickname)
                .font(MomentsFont.caption().weight(.semibold))
                .foregroundStyle(MomentsColor.text)
                .lineLimit(1)
            if isMe { YouBadge() }
            VStack(spacing: Spacing.xxs) {
                Text(verbatim: "\(entry.rank)")
                    .font(MomentsFont.display(.title2))
                    .foregroundStyle(position == 0 ? MomentsColor.onAccent : MomentsColor.text)
                Text("^[\(entry.totalPoints) pt](inflect: true)")
                    .font(MomentsFont.number(.caption))
                    .foregroundStyle(position == 0 ? MomentsColor.onAccent : MomentsColor.textMuted)
            }
            .frame(maxWidth: .infinity, minHeight: Self.stepHeights[position] * scale, alignment: .top)
            .padding(.top, Spacing.xs)
            .background(
                position == 0 ? MomentsColor.accent : MomentsColor.surface,
                in: UnevenRoundedRectangle(topLeadingRadius: Radius.card, topTrailingRadius: Radius.card)
            )
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(LeaderboardLabels.entry(entry, isMe: isMe))
    }
}

enum LeaderboardLabels {
    /// One sentence per guest, so each language can order it.
    static func entry(_ entry: LeaderboardEntry, isMe: Bool) -> Text {
        isMe
            ? Text("Rank \(entry.rank), you, ^[\(entry.totalPoints) point](inflect: true)")
            : Text("Rank \(entry.rank), \(entry.nickname), ^[\(entry.totalPoints) point](inflect: true)")
    }
}

private struct YouBadge: View {
    var body: some View {
        Text("You")
            .font(MomentsFont.caption().bold())
            .foregroundStyle(MomentsColor.onAccent)
            .padding(.horizontal, Spacing.xs)
            .background(MomentsColor.accent, in: Capsule())
    }
}

/// A guest's face from their avatar seed (drawn on device, as on the web),
/// or their initial when they have no seed.
struct GuestAvatar: View {
    let nickname: String
    let seed: String?
    let size: CGFloat

    var body: some View {
        if let seed, !seed.isEmpty {
            AvatarView(seed: seed, size: size)
        } else {
            InitialsAvatar(nickname: nickname, size: size)
        }
    }
}

/// A guest's initial, for guests without an avatar seed.
struct InitialsAvatar: View {
    let nickname: String
    let size: CGFloat

    /// The first character (a whole grapheme, so emoji and accents survive).
    nonisolated static func initial(of nickname: String) -> String {
        nickname.trimmingCharacters(in: .whitespacesAndNewlines).first.map { String($0).uppercased() } ?? "?"
    }

    var body: some View {
        Text(verbatim: Self.initial(of: nickname))
            .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
            .foregroundStyle(MomentsColor.text)
            .frame(width: size, height: size)
            .background(MomentsColor.surface, in: Circle())
            .overlay { Circle().stroke(MomentsColor.textMuted.opacity(0.4), lineWidth: 1) }
            .accessibilityHidden(true)
    }
}
