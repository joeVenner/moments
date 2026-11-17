/// Points and milestones, ported from `src/client/lib/points.ts`.
/// Keep both in sync: the server awards the same values.
public enum Points {
    /// Ascending point totals that trigger a one-time celebration.
    public static let milestones: [Int] = [5, 10, 25, 50, 100]

    /// Points for one upload: videos are worth 3, everything else 1.
    public static func forContentType(_ contentType: String) -> Int {
        contentType.lowercased().hasPrefix("video/") ? 3 : 1
    }

    /// The highest milestone crossed going from `before` to `after`, or nil.
    /// A batch that jumps several thresholds celebrates once, at the highest.
    public static func highestMilestoneCrossed(
        from before: Int,
        to after: Int,
        milestones: [Int] = Points.milestones
    ) -> Int? {
        milestones.last { before < $0 && after >= $0 }
    }
}
