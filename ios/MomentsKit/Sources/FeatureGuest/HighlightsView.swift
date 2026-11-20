import DesignSystem
import MomentsDomain
import SwiftUI

/// The event's most-hearted moments in a grid; tapping one opens the viewer.
public struct HighlightsView: View {
    let model: HighlightsModel
    let thumbnails: ThumbnailLoader
    let viewerImages: ThumbnailLoader
    #if os(iOS)
    @State private var viewing: ViewerRequest?
    #endif

    private static let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 3)

    /// Shown in its event (sections stay alive while hidden).
    let isSelected: Bool

    public init(model: HighlightsModel, thumbnails: ThumbnailLoader, viewerImages: ThumbnailLoader, isSelected: Bool = true) {
        self.model = model
        self.isSelected = isSelected
        self.thumbnails = thumbnails
        self.viewerImages = viewerImages
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                Text("The moments guests love most")
                    .font(MomentsFont.body())
                    .foregroundStyle(MomentsColor.textMuted)
                    .padding(.horizontal, Spacing.md)
                content
            }
            .padding(.vertical, Spacing.md)
        }
        .refreshable { await model.refresh() }
        .background(MomentsColor.background)
        // Each time the tab is shown; the model skips fresh reloads.
        // Each time the section is shown, like a tab's onAppear.
        .onChange(of: isSelected, initial: true) {
            if isSelected { Task { await model.loadIfStale() } }
        }
        #if os(iOS)
        // Moments reported from the viewer leave the list once it's closed.
        .fullScreenCover(item: $viewing, onDismiss: { model.viewerDidClose() }) { request in
            MomentViewer(model: model, images: viewerImages, start: request.id)
                .presentationBackground(.clear)
        }
        #endif
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView()
                .tint(MomentsColor.textMuted)
                .frame(maxWidth: .infinity, minHeight: 200)
                .accessibilityLabel(Text("Loading highlights"))
        case .failed:
            GuestMessage(title: "Can't reach Moments", detail: "Check your connection and try again.")
            Button("Try again") { Task { await model.refresh() } }
                .buttonStyle(.momentsPrimary)
                .padding(.horizontal, Spacing.md)
        case .loaded where model.moments.isEmpty:
            GuestMessage(title: "No highlights yet", detail: "Heart your favourite moments and they'll show up here.")
        case .loaded:
            LazyVGrid(columns: Self.columns, spacing: 2) {
                ForEach(model.moments) { moment in
                    Button { open(moment) } label: {
                        MomentThumbnail(moment: moment, thumbnails: thumbnails)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(Text("Opens it full screen"))
                }
            }
        }
    }

    private func open(_ moment: Moment) {
        #if os(iOS)
        viewing = ViewerRequest(id: moment.id)
        #endif
    }
}

/// A heading and a line of explanation, for empty and error states.
struct GuestMessage: View {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(title)
                .font(MomentsFont.heading())
                .foregroundStyle(MomentsColor.text)
            Text(detail)
                .font(MomentsFont.body())
                .foregroundStyle(MomentsColor.textMuted)
        }
        .padding(.horizontal, Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
