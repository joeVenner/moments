import Foundation

/// The API's timestamp format: UTC `YYYY-MM-DD HH:MM:SS` (SQLite `datetime('now')`).
///
/// Parsed by hand instead of with `DateFormatter`, which depends on the
/// device's calendar and locale settings unless every option is pinned.
public enum ServerDate {
    /// Parses a server timestamp, or returns nil when the text is not exactly that format.
    public static func parse(_ text: String) -> Date? {
        let bytes = Array(text.utf8)
        guard bytes.count == 19,
              bytes[4] == UInt8(ascii: "-"), bytes[7] == UInt8(ascii: "-"),
              bytes[10] == UInt8(ascii: " "),
              bytes[13] == UInt8(ascii: ":"), bytes[16] == UInt8(ascii: ":"),
              let year = number(bytes, 0, 4), let month = number(bytes, 5, 2), let day = number(bytes, 8, 2),
              let hour = number(bytes, 11, 2), let minute = number(bytes, 14, 2), let second = number(bytes, 17, 2)
        else { return nil }
        // The server only writes years 2000+; year 0 has no Gregorian meaning.
        guard year >= 1 else { return nil }

        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = hour
        components.minute = minute
        components.second = second
        // Reject values the calendar would silently roll over (2026-02-31, 25:00:00).
        guard components.isValidDate(in: utcCalendar) else { return nil }
        return utcCalendar.date(from: components)
    }

    /// Formats a date the way the server writes it (seconds precision, UTC).
    public static func format(_ date: Date) -> String {
        date.formatted(formatStyle)
    }

    private static let formatStyle = Date.ISO8601FormatStyle(timeZone: .gmt)
        .year().month().day()
        .dateSeparator(.dash)
        .dateTimeSeparator(.space)
        .time(includingFractionalSeconds: false)
        .timeSeparator(.colon)

    private static let utcCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar
    }()

    private static func number(_ bytes: [UInt8], _ start: Int, _ length: Int) -> Int? {
        var value = 0
        for byte in bytes[start..<(start + length)] {
            guard (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) else { return nil }
            value = value * 10 + Int(byte - UInt8(ascii: "0"))
        }
        return value
    }
}
