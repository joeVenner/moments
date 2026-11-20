import DesignSystem
import SwiftUI

/// When the first-launch welcome shows, kept apart from the view so it can be tested.
enum OnboardingFlow {
    /// UserDefaults key: set once the welcome has been answered or skipped.
    static let completedKey = "moments.onboarding.completed"

    /// Whether to show the welcome: not once done, and not when the app
    /// opened on an event (any event link counts, even one that stops at a
    /// PIN: the guest came to join, not to read).
    static func shouldShow(completed: Bool, isShowingEvent: Bool) -> Bool {
        !completed && !isShowingEvent
    }
}

/// What the welcome's buttons ask the home screen to open.
enum WelcomeChoice: Equatable {
    /// "Join an event": the scanner, over the Events tab.
    case join
    /// "Host an event": the Hosting tab, where hosts sign in.
    case host

    var tab: AppTab {
        switch self {
        case .join: .events
        case .host: .hosting
        }
    }

    var opensScanner: Bool { self == .join }

    /// The pending choice, once: it is cleared as it is taken, so a home
    /// screen rebuilt later (after an event link closes) doesn't reopen it.
    static func take(_ pending: inout WelcomeChoice?) -> WelcomeChoice? {
        defer { pending = nil }
        return pending
    }
}

/// The guest-count tiers hosting is sold in (products host_50 … host_600).
/// Prices aren't shown here: the App Store localises them, and the paywall
/// reads them from StoreKit.
struct WelcomePlan: Identifiable {
    let guests: Int
    let fit: LocalizedStringResource
    var id: Int { guests }

    static let all = [
        WelcomePlan(guests: 50, fit: "Birthdays and dinners"),
        WelcomePlan(guests: 150, fit: "Most weddings"),
        WelcomePlan(guests: 300, fit: "Big weddings and parties"),
        WelcomePlan(guests: 600, fit: "Corporate and festivals"),
    ]
}

/// The first launch: what Moments is, how it works and how hosting is sold
/// (the website's landing, on a phone), then join or host.
struct OnboardingView: View {
    /// nil: "Not now".
    let onFinish: (WelcomeChoice?) -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private struct Step: Identifiable {
        let number: Int
        let title: LocalizedStringResource
        let detail: LocalizedStringResource
        var id: Int { number }
    }

    private static let steps = [
        Step(number: 1, title: "Create your event", detail: "A name, a date, who it is about. Make it private with a PIN if you like."),
        Step(number: 2, title: "Put the QR on the tables", detail: "Print the flyer or share the link. Guests scan and they're in: no account, no download."),
        Step(number: 3, title: "Watch it fill up", detail: "Photos and videos land in one live feed. Hearts, points and a leaderboard keep everyone sharing."),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                hero
                howItWorks
                plans
                // At the largest text sizes pinned buttons would leave little
                // room to scroll: they scroll with the rest instead.
                if dynamicTypeSize.isAccessibilitySize { actions }
            }
            .padding(.horizontal, Spacing.lg)
            .padding(.vertical, Spacing.xl)
            .frame(maxWidth: 600, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !dynamicTypeSize.isAccessibilitySize { pinnedActions }
        }
        .background(MomentsColor.background.ignoresSafeArea())
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text(verbatim: "Moments")
                .font(MomentsFont.display(.title2))
                .foregroundStyle(MomentsColor.text)
                .accessibilityHidden(true)
            HStack(spacing: Spacing.xs) {
                Circle().fill(MomentsColor.accent).frame(width: 8, height: 8).accessibilityHidden(true)
                Text("For weddings, birthdays and every party")
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.textMuted)
            }
            .padding(.horizontal, Spacing.sm)
            .padding(.vertical, Spacing.xs)
            .background(MomentsColor.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(MomentsColor.border))
            VStack(alignment: .leading, spacing: 0) {
                Text("Every guest's camera.")
                    .foregroundStyle(MomentsColor.text)
                Text("One shared album.")
                    .foregroundStyle(MomentsColor.accent)
            }
            .font(MomentsFont.display(.largeTitle))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Text("Guests scan a QR code and share photos and videos from their phone, with nothing to install. You keep every moment, in full quality.")
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var howItWorks: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            sectionTitle("How it works")
            ForEach(Self.steps) { step in
                HStack(alignment: .top, spacing: Spacing.md) {
                    Text(step.number, format: .number)
                        .font(MomentsFont.heading(.headline))
                        .foregroundStyle(MomentsColor.onAccent)
                        .frame(width: 36, height: 36)
                        .background(MomentsColor.accent, in: Circle())
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        Text(step.title)
                            .font(MomentsFont.heading(.headline))
                            .foregroundStyle(MomentsColor.text)
                        Text(step.detail)
                            .font(MomentsFont.body(.subheadline))
                            .foregroundStyle(MomentsColor.textMuted)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(Spacing.md)
                .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.card))
                .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(MomentsColor.border))
                .accessibilityElement(children: .combine)
            }
        }
    }

    private var plans: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            sectionTitle("Hosting plans")
            Text("One monthly plan, sized by how many guests will share. Each includes your main event and a test event.")
                .font(MomentsFont.body(.subheadline))
                .foregroundStyle(MomentsColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 0) {
                ForEach(WelcomePlan.all) { plan in
                    HStack {
                        Text("Up to \(plan.guests) guests")
                            .font(MomentsFont.heading(.headline))
                            .foregroundStyle(MomentsColor.text)
                        Spacer(minLength: Spacing.sm)
                        Text(plan.fit)
                            .font(MomentsFont.caption())
                            .foregroundStyle(MomentsColor.textMuted)
                            .multilineTextAlignment(.trailing)
                    }
                    .padding(.vertical, Spacing.sm)
                    .accessibilityElement(children: .combine)
                    if plan.guests != WelcomePlan.all.last?.guests {
                        Divider().overlay(MomentsColor.border)
                    }
                }
            }
            .padding(.horizontal, Spacing.md)
            .background(MomentsColor.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(MomentsColor.border))
            Text("Guests never pay. Prices are shown when you subscribe.")
                .font(MomentsFont.caption())
                .foregroundStyle(MomentsColor.textMuted)
        }
    }

    private var pinnedActions: some View {
        actions
            .padding(.horizontal, Spacing.lg)
            .padding(.top, Spacing.sm)
            .frame(maxWidth: 600)
            .frame(maxWidth: .infinity)
            .background(MomentsColor.background.ignoresSafeArea(edges: .bottom))
            .overlay(alignment: .top) { Divider().overlay(MomentsColor.border) }
    }

    private var actions: some View {
        VStack(spacing: Spacing.sm) {
            Button("Join an event") { onFinish(.join) }
                .buttonStyle(.momentsPrimary)
            Button("Host an event") { onFinish(.host) }
                .buttonStyle(.momentsSecondary)
            Button("Not now") { onFinish(nil) }
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
                .frame(minHeight: Radius.minimumTapTarget)
        }
    }

    private func sectionTitle(_ title: LocalizedStringResource) -> some View {
        Text(title)
            .font(MomentsFont.display(.title2))
            .foregroundStyle(MomentsColor.text)
            .accessibilityAddTraits(.isHeader)
    }
}
