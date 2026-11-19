import Foundation
import MomentsDomain

/// Pure formatting for the host's event stats (tested without views).
enum HostEventStats {
    struct Tile: Hashable, Identifiable {
        let title: String
        let value: String
        var id: String { title }
    }

    static func tiles(_ analytics: EventAnalytics, locale: Locale = .current) -> [Tile] {
        let number = { (value: Int) in value.formatted(.number.locale(locale)) }
        return [
            Tile(title: String(localized: "Moments"), value: number(analytics.totalMoments)),
            Tile(title: String(localized: "Hidden"), value: number(analytics.hiddenMoments)),
            Tile(title: String(localized: "Photos"), value: number(analytics.photos)),
            Tile(title: String(localized: "Videos"), value: number(analytics.videos)),
            Tile(title: String(localized: "Guests"), value: number(analytics.participants)),
            Tile(title: String(localized: "Hearts"), value: number(analytics.reactions)),
            Tile(
                title: String(localized: "Storage"),
                value: Int64(analytics.storageBytes).formatted(.byteCount(style: .file).locale(locale))
            ),
        ]
    }

    /// The last 14 UTC days ending `today`, oldest first, with 0 for days the
    /// server left out (it only sends days that had uploads).
    static func lastTwoWeeks(_ activity: [EventAnalytics.DayCount], today: Date = .now) -> [EventAnalytics.DayCount] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let counts = Dictionary(activity.map { ($0.day, $0.count) }, uniquingKeysWith: +)
        let start = calendar.startOfDay(for: today)
        return (0..<14).reversed().compactMap { offset -> EventAnalytics.DayCount? in
            guard let date = calendar.date(byAdding: .day, value: -offset, to: start) else { return nil }
            let parts = calendar.dateComponents([.year, .month, .day], from: date)
            let day = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
            return EventAnalytics.DayCount(day: day, count: counts[day] ?? 0)
        }
    }
}
