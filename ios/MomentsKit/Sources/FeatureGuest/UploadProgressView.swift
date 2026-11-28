import DesignSystem
import SwiftUI
import UploadEngine

/// This event's uploads: what's waiting, sending, done or stuck.
public struct UploadProgressView: View {
    let model: UploadProgressModel
    /// The event they go to, named under the title.
    let eventTitle: String?
    /// Off where uploads ignore it (the App Clip sends over any network).
    let showsWiFiChoice: Bool
    @Environment(\.dismiss) private var dismiss

    public init(model: UploadProgressModel, eventTitle: String? = nil, showsWiFiChoice: Bool = true) {
        self.model = model
        self.eventTitle = eventTitle
        self.showsWiFiChoice = showsWiFiChoice
    }

    public var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Your uploads") {
                if model.doneCount > 0 {
                    Button("Clear finished") { Task { await model.clearDone() } }
                }
            } trailing: {
                Button("Done") { dismiss() }
                    .fontWeight(.semibold)
            }
            Group {
                if model.rows.isEmpty {
                    Text("Nothing is uploading.")
                        .font(MomentsFont.body())
                        .foregroundStyle(MomentsColor.textMuted)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List {
                        UploadQueueHeader(model: model, eventTitle: eventTitle)
                            .listRowBackground(MomentsColor.background)
                            .listRowSeparator(.hidden)
                        if model.couldNotRemove {
                            Text("Couldn't remove that from this device. Try again.")
                                .font(MomentsFont.body(.footnote))
                                .foregroundStyle(MomentsColor.accent)
                                .listRowBackground(MomentsColor.surface)
                        }
                        ForEach(model.rows) { row in
                            UploadProgressRow(row: row) {
                                Task { await model.retry(row.id) }
                            }
                            .listRowBackground(MomentsColor.surface)
                            .swipeActions {
                                if row.isFinished {
                                    Button("Remove", role: .destructive) { Task { await model.remove(row.id) } }
                                }
                            }
                        }
                    }
                    .scrollContentBackground(.hidden)
                }
            }
            // Also with nothing queued, so it can be set before sharing.
            .safeAreaInset(edge: .bottom) {
                if showsWiFiChoice { LargeVideosSetting(onChange: model.refresh) }
            }
        }
        .background(MomentsColor.background.ignoresSafeArea())
        // Sheets don't inherit the event screen's tint.
        .tint(MomentsColor.accent)
    }
}

/// "Sharing 6 moments to …": the batch's progress over its items.
struct UploadQueueHeader: View {
    let model: UploadProgressModel
    let eventTitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(Self.title(model.headline))
                    .font(MomentsFont.display(.title2))
                    .foregroundStyle(MomentsColor.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let eventTitle {
                    Text("to \(eventTitle)", comment: "Under the uploads title: the event they go to.")
                        .font(MomentsFont.body())
                        .foregroundStyle(MomentsColor.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                ProgressView(value: model.overallFraction)
                    .tint(MomentsColor.accent)
                Text("\(model.doneCount) of \(model.rows.count) shared")
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.textMuted)
            }
            // One stop: the count says it better than a percentage.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("\(model.doneCount) of \(model.rows.count) shared"))
            if model.activeCount > 0, model.failedCount > 0 {
                Text("^[\(model.failedCount) moment](inflect: true) couldn't be shared")
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.accent)
            }
            if model.activeCount > 0 {
                Text("You can lock your phone. Sharing carries on in the background.")
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, Spacing.xs)
    }

    static func title(_ headline: UploadProgressModel.Headline) -> LocalizedStringResource {
        switch headline {
        case let .sharing(count): "Sharing ^[\(count) moment](inflect: true)"
        case let .someFailed(count): "^[\(count) moment](inflect: true) couldn't be shared"
        case .allShared: "All shared"
        }
    }
}

/// The guest's choice to keep large videos off mobile data.
struct LargeVideosSetting: View {
    @AppStorage(CellularPolicy.largeVideosOnWiFiOnlyKey) private var isWiFiOnly = CellularPolicy.isWiFiOnlyByDefault
    /// So the rows show the new choice at once.
    let onChange: () -> Void

    var body: some View {
        Toggle(isOn: $isWiFiOnly) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text("Large videos on Wi-Fi only")
                    .font(MomentsFont.body())
                    .foregroundStyle(MomentsColor.text)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Saves your mobile data. Applies to what hasn't started sending.")
                    .font(MomentsFont.caption())
                    .foregroundStyle(MomentsColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .tint(MomentsColor.accent)
        .onChange(of: isWiFiOnly) { onChange() }
        .padding(Spacing.md)
        .background(MomentsColor.surface)
        .overlay(alignment: .top) { MomentsColor.border.frame(height: 1) }
    }
}

struct UploadProgressRow: View {
    let row: UploadProgressModel.Row
    let retry: () -> Void

    var body: some View {
        HStack(spacing: Spacing.sm) {
            Image(systemName: row.isVideo ? "video" : "photo")
                .foregroundStyle(MomentsColor.textMuted)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                if let caption = row.caption, !caption.isEmpty {
                    Text(caption)
                        .font(MomentsFont.body())
                        .foregroundStyle(MomentsColor.text)
                        .lineLimit(1)
                }
                Text(statusText)
                    .font(MomentsFont.body(.footnote))
                    .foregroundStyle(isProblem ? MomentsColor.accent : MomentsColor.textMuted)
                if case let .uploading(fraction) = row.status {
                    ProgressView(value: fraction)
                        .tint(MomentsColor.accent)
                        .accessibilityHidden(true)
                }
            }
            Spacer(minLength: 0)
            if row.canRetry {
                Button("Try again", action: retry)
                    .font(MomentsFont.body(.footnote).bold())
                    .foregroundStyle(MomentsColor.accent)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                    .buttonStyle(.momentsBare)
            } else if row.status == .done {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(MomentsColor.accent)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, Spacing.xs)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(accessibilityText))
        .accessibilityActions {
            if row.canRetry { Button("Try again", action: retry) }
        }
    }

    private var isProblem: Bool {
        if case .failed = row.status { true } else { false }
    }

    private var statusText: LocalizedStringResource {
        switch row.status {
        case .waiting: "Waiting"
        case .waitingForWiFi: "Waiting for Wi-Fi"
        case let .uploading(fraction): "Uploading \(Int((fraction * 100).rounded()))%"
        case .finishing: "Finishing"
        case .done: "Shared"
        case let .failed(failure, _): Self.message(failure)
        }
    }

    private var accessibilityText: String {
        let kind = row.isVideo ? String(localized: "Video") : String(localized: "Photo")
        return [kind, row.caption, String(localized: statusText)].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: ", ")
    }

    static func message(_ failure: QueuedUpload.Failure) -> LocalizedStringResource {
        switch failure {
        case .uploadsClosed: "The event stopped taking uploads."
        case .eventGone: "This event no longer exists."
        case .accessLost: "Open the event link again, then try again."
        case .refused: "This file can't be shared."
        case .rejected: "The upload didn't arrive intact."
        case .appTooOld: "Update Moments, then try again."
        case .unavailable: "Uploads are unavailable right now."
        case .gaveUp: "Couldn't upload. Check your connection."
        case .sessionLost: "This upload was lost on the server."
        case .fileLost: "The file is no longer on this device."
        }
    }
}
