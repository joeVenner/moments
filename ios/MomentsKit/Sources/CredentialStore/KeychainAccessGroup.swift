/// Keychain access group names as the build provides them (Info.plist).
public enum KeychainAccessGroup {
    /// Nil unless it starts with a team ID ("ABCDE12345."): an unsigned build
    /// leaves the prefix empty, and a group without it is never entitled.
    public static func validated(_ group: String?) -> String? {
        guard let group, group.wholeMatch(of: /[A-Z0-9]{10}\.[A-Za-z0-9.-]+/) != nil else { return nil }
        return group
    }
}
