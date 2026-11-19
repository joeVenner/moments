/// Points and milestones, ported from `src/client/lib/points.ts`.
/// Keep both in sync: the server awards the same values.
public enum Points {
    /// Ascending point totals that trigger a one-time celebration.
    public static let milestones: [Int] = [5, 10, 25, 50, 100]

    /// What one photo (or any non-video upload) earns.
    public static let photoPoints = 1
    /// What one video earns.
    public static let videoPoints = 3

    /// Points for one upload: videos are worth 3, everything else 1.
    public static func forContentType(_ contentType: String) -> Int {
        contentType.lowercased().hasPrefix("video/") ? videoPoints : photoPoints
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

    /// The way from the last milestone reached to the next one.
    public struct MilestoneProgress: Equatable, Sendable {
        /// The next milestone's point total.
        public let target: Int
        /// Points still to earn, at least 1.
        public let remaining: Int
        /// 0...1 from the previous milestone (or zero) to `target`.
        public let fraction: Double
    }

    /// Nil once every milestone is behind (or with none). `milestones`
    /// must be ascending, like `Points.milestones`.
    public static func progress(toward points: Int, milestones: [Int] = Points.milestones) -> MilestoneProgress? {
        let points = max(points, 0)
        guard let target = milestones.first(where: { $0 > points }) else { return nil }
        let previous = milestones.last { $0 <= points } ?? 0
        let fraction = Double(points - previous) / Double(target - previous)
        return MilestoneProgress(target: target, remaining: target - points, fraction: fraction)
    }
}
