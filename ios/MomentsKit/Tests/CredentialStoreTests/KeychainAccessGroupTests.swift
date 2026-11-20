import CredentialStore
import Testing

@Suite struct KeychainAccessGroupTests {
    @Test(arguments: [
        ("7877JLKPRQ.com.moments-hq.moments", true),
        ("7877JLKPRQ.com.moments-hq.moments.shared", true),
        ("com.moments-hq.moments", false),
        ("$(AppIdentifierPrefix)com.moments-hq.moments", false),
        ("7877jlkprq.com.moments-hq.moments", false),
        ("", false),
    ])
    func accessGroupsNeedATeamPrefix(_ value: String, _ isValid: Bool) {
        #expect((KeychainAccessGroup.validated(value) != nil) == isValid)
        #expect(KeychainAccessGroup.validated(nil) == nil)
    }
}
