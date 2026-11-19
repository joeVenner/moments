import DesignSystem
import FeatureGuest
import MomentsDomain
import SwiftUI

/// "Your events" on the home screen; a tap opens the event.
struct MyEventsList: View {
    let entries: [MyEventsModel.Entry]
    let open: (EventSlug) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Your events")
                .font(MomentsFont.display(.title2))
                .foregroundStyle(MomentsColor.text)
                .accessibilityAddTraits(.isHeader)
            ForEach(entries) { entry in
                Button { open(entry.slug) } label: { row(entry) }
                    .buttonStyle(.plain)
                    .accessibilityHint(Text("Opens the event"))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, Spacing.lg)
    }

    private func row(_ entry: MyEventsModel.Entry) -> some View {
        HStack(spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text(title(entry))
                    .font(MomentsFont.body().bold())
                    .foregroundStyle(MomentsColor.text)
                    .multilineTextAlignment(.leading)
                Text(detail(entry))
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.textMuted)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: Spacing.sm)
            Image(systemName: "chevron.forward")
                .foregroundStyle(MomentsColor.textMuted)
                .accessibilityHidden(true)
        }
        .padding(Spacing.md)
        .frame(minHeight: Radius.minimumTapTarget)
        .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .contentShape(RoundedRectangle(cornerRadius: Radius.card))
        .accessibilityElement(children: .combine)
    }

    private func title(_ entry: MyEventsModel.Entry) -> String {
        if case let .loaded(event) = entry.details { return event.title }
        return entry.slug.value
    }

    private func detail(_ entry: MyEventsModel.Entry) -> String {
        let status: String
        switch entry.details {
        case let .loaded(event):
            status = (event.startsAt ?? event.createdAt).formatted(date: .abbreviated, time: .omitted)
        case .locked:
            status = String(localized: "Enter the PIN again to open it")
        case .unavailable:
            status = String(localized: "Details unavailable right now")
        }
        guard let nickname = entry.nickname else { return status }
        return String(localized: "\(status) · as \(nickname)")
    }
}
