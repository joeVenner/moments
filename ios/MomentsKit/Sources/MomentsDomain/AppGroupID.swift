/// The one check on an App Group id (read from Info.plist) before any
/// container is looked up for it: `group.` plus dot-separated letters,
/// digits and hyphens, so it can't name a path.
public enum AppGroupID {
    public static func isValid(_ id: String?) -> Bool {
        guard let id else { return false }
        return id.wholeMatch(of: /group\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/) != nil
    }
}
