import DesignSystem
import MomentsDomain
import SwiftUI

/// The guests this guest muted, each with an Unmute button.
struct MutedGuestsView: View {
    let model: LeaderboardModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if model.mutedGuests.isEmpty {
                    Text("Guests you mute from a moment show up here.")
                        .font(MomentsFont.body())
                        .foregroundStyle(MomentsColor.textMuted)
                        .multilineTextAlignment(.center)
                        .padding(Spacing.lg)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List {
                        if model.unmuteFailed {
                            Text("Couldn't unmute. Try again.")
                                .font(MomentsFont.body(.footnote))
                                .foregroundStyle(MomentsColor.accent)
                                .listRowBackground(MomentsColor.surface)
                        }
                        Section {
                            ForEach(model.mutedGuests) { guest in
                                row(guest).listRowBackground(MomentsColor.surface)
                            }
                        } footer: {
                            Text("Their moments are hidden on this phone only. They aren't told.")
                                .font(MomentsFont.body(.footnote))
                                .foregroundStyle(MomentsColor.textMuted)
                        }
                    }
                    .scrollContentBackground(.hidden)
                }
            }
            .background(MomentsColor.background)
            .navigationTitle("Muted guests")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onChange(of: model.unmuteFailed) { _, failed in
            if failed { AccessibilityNotification.Announcement(String(localized: "Couldn't unmute. Try again.")).post() }
        }
        .task {
            model.reloadMuted()
            // Names come from the board.
            await model.loadIfStale()
        }
    }

    private func row(_ guest: MutedGuest) -> some View {
        let name = MutedGuestsView.name(guest)
        return HStack(spacing: Spacing.sm) {
            GuestAvatar(nickname: guest.entry?.nickname ?? "", seed: guest.entry?.avatarSeed, size: 32)
                .accessibilityHidden(true)
            Text(verbatim: name)
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.text)
                .lineLimit(1)
            Spacer()
            Button("Unmute") { model.unmute(participantID: guest.id) }
                .buttonStyle(.bordered)
                .tint(MomentsColor.accent)
                .accessibilityLabel(Text("Unmute \(name)"))
        }
        .frame(minHeight: Radius.minimumTapTarget)
    }

    /// Their nickname, or a stand-in when they're not on the board.
    static func name(_ guest: MutedGuest) -> String {
        guest.entry?.nickname ?? String(localized: "A guest")
    }
}
