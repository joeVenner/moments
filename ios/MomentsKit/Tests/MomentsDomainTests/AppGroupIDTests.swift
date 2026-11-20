import MomentsDomain
import Testing

@Suite struct AppGroupIDTests {
    @Test(arguments: ["group.com.moments-hq.moments", "group.a.b"])
    func acceptsAGroup(_ id: String) {
        #expect(AppGroupID.isValid(id))
    }

    @Test(arguments: [nil, "", "com.moments-hq.moments", "group.", "group.moments", "group.a/../b.c", "group.a.b/c", "group.a.b ", "xgroup.a.b"])
    func refusesAnythingElse(_ id: String?) {
        #expect(!AppGroupID.isValid(id))
    }
}
