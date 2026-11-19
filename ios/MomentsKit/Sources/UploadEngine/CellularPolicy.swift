import Foundation

/// Whether an upload may use mobile data. Large videos can be held for
/// Wi-Fi (the guest's choice, on by default); everything else always may.
public enum CellularPolicy {
    /// UserDefaults key of the guest's choice.
    public static let largeVideosOnWiFiOnlyKey = "uploads.largeVideosOnWiFiOnly"
    /// The choice before the guest makes one.
    public static let isWiFiOnlyByDefault = true
    /// From this size a video counts as large.
    public static let largeVideoBytes: Int64 = 100 * 1024 * 1024

    /// The guest's choice; on until they turn it off.
    public static func largeVideosOnWiFiOnly(in defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: largeVideosOnWiFiOnlyKey) as? Bool ?? isWiFiOnlyByDefault
    }

    /// False only for a large video while the guest wants those on Wi-Fi.
    public static func allowsMobileData(contentType: String, size: Int64, largeVideosOnWiFiOnly: Bool) -> Bool {
        guard largeVideosOnWiFiOnly else { return true }
        let isVideo = contentType.lowercased().hasPrefix("video/")
        return !(isVideo && size >= largeVideoBytes)
    }
}
