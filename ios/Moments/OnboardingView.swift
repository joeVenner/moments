import DesignSystem
import SwiftUI

/// Where the first-launch pages are, kept apart from the view so it can be tested.
struct OnboardingFlow: Equatable {
    /// UserDefaults key: set once the guest has finished or skipped the pages.
    static let completedKey = "moments.onboarding.completed"

    let pageCount: Int
    private(set) var page = 0

    init(pageCount: Int) {
        precondition(pageCount > 0, "onboarding needs at least one page")
        self.pageCount = pageCount
    }

    /// Whether to show the pages: not once done, and not when the app opened
    /// on an event (any event link counts, even one that stops at a PIN: the
    /// guest came to join, not to read).
    static func shouldShow(completed: Bool, isShowingEvent: Bool) -> Bool {
        !completed && !isShowingEvent
    }

    var isLastPage: Bool { page == pageCount - 1 }

    /// Moves to the next page; false when there is none (the flow is done).
    mutating func advance() -> Bool {
        guard !isLastPage else { return false }
        page += 1
        return true
    }

    /// For the pager's own swipes; clamped to the pages that exist.
    mutating func show(_ page: Int) {
        self.page = min(max(page, 0), pageCount - 1)
    }
}

/// Three short pages shown on the first launch: what Moments is, how to join,
/// what a guest can do. Skippable; never shown again once done.
struct OnboardingView: View {
    let onFinish: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var flow = OnboardingFlow(pageCount: Self.pages.count)
    @ScaledMetric(relativeTo: .largeTitle) private var symbolSize: CGFloat = 64

    private struct Page {
        let symbol: String
        let title: LocalizedStringResource
        let detail: LocalizedStringResource
    }

    private static let pages = [
        Page(
            symbol: "sparkles",
            title: "Every moment, together",
            detail: "Moments gathers the photos and videos guests take at an event into one live feed."
        ),
        Page(
            symbol: "qrcode.viewfinder",
            title: "Scan to join",
            detail: "Scan the event's QR code, pick a name, and you're in. No account needed."
        ),
        Page(
            symbol: "heart.fill",
            title: "Share and heart",
            detail: "Share your photos and videos, heart your favourites, and climb the leaderboard."
        ),
    ]

    var body: some View {
        VStack(spacing: Spacing.lg) {
            HStack {
                Spacer()
                Button(action: onFinish) {
                    Text("Skip")
                        .font(MomentsFont.body())
                        .foregroundStyle(MomentsColor.textMuted)
                        .frame(minWidth: Radius.minimumTapTarget, minHeight: Radius.minimumTapTarget)
                        .contentShape(Rectangle())
                }
                    .opacity(flow.isLastPage ? 0 : 1)
                    .accessibilityHidden(flow.isLastPage)
                    .disabled(flow.isLastPage)
            }
            TabView(selection: Binding(get: { flow.page }, set: { flow.show($0) })) {
                ForEach(Self.pages.indices, id: \.self) { index in
                    pageView(Self.pages[index]).tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
            .indexViewStyle(.page(backgroundDisplayMode: .interactive))
            Button(flow.isLastPage ? "Get started" : "Next", action: next)
                .buttonStyle(.momentsPrimary)
        }
        .padding(Spacing.lg)
        .background(MomentsColor.background.ignoresSafeArea())
    }

    /// Centred when it fits; scrolls at large text sizes instead of clipping.
    private func pageView(_ page: Page) -> some View {
        GeometryReader { proxy in
            ScrollView {
                pageContent(page)
                    // At least the page's height (centred), more when the text needs it.
                    .frame(minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }

    private func pageContent(_ page: Page) -> some View {
        VStack(spacing: Spacing.md) {
            Image(systemName: page.symbol)
                .font(.system(size: symbolSize, weight: .regular))
                .foregroundStyle(MomentsColor.accent)
                .accessibilityHidden(true)
            Text(page.title)
                .font(MomentsFont.display(.title))
                .foregroundStyle(MomentsColor.text)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
                .fixedSize(horizontal: false, vertical: true)
            Text(page.detail)
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, Spacing.md)
        // Room for the page dots, which the pager draws over the bottom edge.
        .padding(.bottom, Spacing.xl * 2)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }

    private func next() {
        withAnimation(Motion.animation(Motion.standard, reduceMotion: reduceMotion)) {
            if !flow.advance() { onFinish() }
        }
    }
}
