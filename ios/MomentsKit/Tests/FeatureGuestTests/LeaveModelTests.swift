import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import FeatureGuest

private let slug = EventSlug("party")!
private let saved = StoredEventCredentials(eventID: "e1", guestToken: "gt_me", participantID: "p1", nickname: "Lea")

/// Answers each call from a script.
private final class FakeLeaver: LeaveService, @unchecked Sendable {
    private let lock = NSLock()
    private var script: [Result<Bool, MomentsAPIError>]
    private(set) var calls: [EventCredentials] = []

    init(_ script: [Result<Bool, MomentsAPIError>]) { self.script = script }

    func leaveEvent(slug: String, credentials: EventCredentials) async throws -> Bool {
        let next: Result<Bool, MomentsAPIError> = lock.withLock {
            calls.append(credentials)
            return script.isEmpty ? .success(false) : script.removeFirst()
        }
        return try next.get()
    }
}

@Suite @MainActor struct LeaveModelTests {
    @Test func callsUntilDoneThenForgetsTheGuest() async {
        let store = InMemoryEventCredentialStore([slug: saved])
        let leaver = FakeLeaver([.success(false), .success(false), .success(true)])
        let model = LeaveModel(slug: slug, service: leaver, store: store)
        await model.leave()
        #expect(model.phase == .left)
        #expect(leaver.calls.count == 3 && leaver.calls.allSatisfy { $0.guestToken == "gt_me" })
        #expect(store.credentials(for: slug) == nil)
    }

    @Test func aRevokedTokenMeansItAlreadyFinished() async {
        let store = InMemoryEventCredentialStore([slug: saved])
        let model = LeaveModel(slug: slug, service: FakeLeaver([.failure(.guestRequired)]), store: store)
        await model.leave()
        #expect(model.phase == .left)
        #expect(store.credentials(for: slug) == nil)
    }

    @Test(arguments: [
        (MomentsAPIError.rateLimited, LeaveModel.Failure.busy),
        (.upgradeRequired, .upgradeRequired),
        (.storageUnavailable, .temporary),
    ])
    func failuresKeepTheIdentityForARetry(_ error: MomentsAPIError, _ failure: LeaveModel.Failure) async {
        let store = InMemoryEventCredentialStore([slug: saved])
        let leaver = FakeLeaver([.success(false), .failure(error), .success(true)])
        let model = LeaveModel(slug: slug, service: leaver, store: store)
        await model.leave()
        #expect(model.phase == .failed(failure))
        #expect(store.credentials(for: slug) == saved)
        model.dismissFailure()
        #expect(model.phase == .idle)
        await model.leave()
        #expect(model.phase == .left)
    }

    @Test func aPurgedEventCountsAsLeft() async {
        let store = InMemoryEventCredentialStore([slug: saved])
        let model = LeaveModel(slug: slug, service: FakeLeaver([.success(false), .failure(.eventNotFound)]), store: store)
        await model.leave()
        #expect(model.phase == .left)
        #expect(store.credentials(for: slug) == nil)
    }

    @Test func ignoresASecondTapWhileLeavingOrAfterLeft() async {
        let store = InMemoryEventCredentialStore([slug: saved])
        let leaver = FakeLeaver([.success(true)])
        let model = LeaveModel(slug: slug, service: leaver, store: store)
        await model.leave()
        await model.leave()
        #expect(model.phase == .left && leaver.calls.count == 1)
    }

    @Test func stopsAfterTooManyStepsWithoutForgetting() async {
        let store = InMemoryEventCredentialStore([slug: saved])
        let leaver = FakeLeaver([])
        let model = LeaveModel(slug: slug, service: leaver, store: store)
        await model.leave()
        #expect(model.phase == .failed(.temporary))
        #expect(leaver.calls.count == LeaveModel.maxSteps)
        #expect(store.credentials(for: slug) == saved)
    }

    @Test func neverJoinedOnThisDeviceJustForgets() async {
        let store = InMemoryEventCredentialStore([slug: StoredEventCredentials(eventID: "e1", accessGrant: "grant", accessGrantExpiresAt: .distantFuture)])
        let leaver = FakeLeaver([])
        let model = LeaveModel(slug: slug, service: leaver, store: store)
        await model.leave()
        #expect(model.phase == .left)
        #expect(leaver.calls.isEmpty)
        #expect(store.credentials(for: slug) == nil)
    }

    @Test func closesTheEventsUploadsForTheWholeLeave() async {
        let store = InMemoryEventCredentialStore([slug: saved])
        let leaver = FakeLeaver([.success(true)])
        let log = CallLog()
        let uploads = LeavingUploads(
            begin: { await log.add("begin \($0)@\(leaver.calls.count)") },
            end: { await log.add("end \($0)@\(leaver.calls.count)") }
        )
        let model = LeaveModel(slug: slug, service: leaver, store: store, uploads: uploads)
        await model.leave()
        #expect(model.phase == .left)
        #expect(await log.entries == ["begin party@0", "end party@1"])
    }

    @Test func reopensUploadsWhenTheLeaveFails() async {
        let store = InMemoryEventCredentialStore([slug: saved])
        let log = CallLog()
        let uploads = LeavingUploads(begin: { await log.add("begin \($0)") }, end: { await log.add("end \($0)") })
        let model = LeaveModel(slug: slug, service: FakeLeaver([.failure(.rateLimited)]), store: store, uploads: uploads)
        await model.leave()
        #expect(model.phase == .failed(.busy))
        #expect(await log.entries == ["begin party", "end party"])
    }
}

private actor CallLog {
    private(set) var entries: [String] = []
    func add(_ entry: String) { entries.append(entry) }
}
