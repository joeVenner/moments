import MomentsDomain

/// What the viewer's report dialog offers for a moment: a report, and a
/// mute of its sharer when this guest may mute them.
struct ReportQuestion: Equatable {
    let momentID: String
    let uploaderName: String
    /// Nil when the sharer can't be muted (this guest, or no id).
    let muteParticipantID: String?

    init(_ moment: Moment, canMute: Bool) {
        momentID = moment.id
        uploaderName = moment.uploaderName.isEmpty ? String(localized: "A guest") : moment.uploaderName
        muteParticipantID = canMute ? moment.uploaderID : nil
    }
}
