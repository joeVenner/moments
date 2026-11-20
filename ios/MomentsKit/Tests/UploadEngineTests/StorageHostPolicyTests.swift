import Testing
@testable import UploadEngine

@Suite struct StorageHostPolicyTests {
    /// The app and the App Clip both send here; a typo would send photos
    /// nowhere (or, worse, to another account).
    @Test func momentsIsExactlyItsOwnAccountsHost() {
        #expect(StorageHostPolicy.moments.domains == ["30062218f6ae591808563f1afd8c479a.r2.cloudflarestorage.com"])
        #expect(StorageHostPolicy.moments.allows("30062218f6ae591808563f1afd8c479a.r2.cloudflarestorage.com"))
        #expect(!StorageHostPolicy.moments.allows("r2.cloudflarestorage.com"))
        #expect(!StorageHostPolicy.moments.allows("other.r2.cloudflarestorage.com"))
    }
}
