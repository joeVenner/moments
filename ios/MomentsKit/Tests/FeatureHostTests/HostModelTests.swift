import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import FeatureHost

/// A one-shot latch for holding a fake request open.
actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func open() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters.removeAll()
    }
}

/// Scripted HostService; all state behind `lock`.
final class FakeHostService: HostService, @unchecked Sendable {
    private let lock = NSLock()
    private var _signInResult: Result<HostSession, Error> = .failure(MomentsAPIError.invalidCredentials)
    private var _eventsResult: Result<AdminEventList, Error> = .success(AdminEventList(events: [], isTruncated: false))
    private var _signOutError: Error?
    private var _signInCalls = 0
    private var _signOutTokens: [String] = []
    private var _eventTokens: [String] = []
    private var _detailResult: Result<AdminEventDetail, Error> = .failure(MomentsAPIError.eventNotFound)
    private var _detailCalls: [(token: String, id: String)] = []
    private var _momentsResult: Result<AdminMomentList, Error> = .success(AdminMomentList(moments: [], isTruncated: false))
    private var _moderateError: Error?
    private var _deleteError: Error?
    private var _moderateCalls: [(id: String, status: AdminMoment.Status)] = []
    private var _deleteCalls: [String] = []
    private var _actionGate: Gate?
    private var _listGate: Gate?
    private var _listCalls = 0
    /// Runs before a sign-in or events request answers (to hold it open).
    let beforeAnswer: Gate?
    private let holdsSignIn: Bool

    /// `holdsSignIn: false` holds only event requests.
    init(holding gate: Gate? = nil, holdsSignIn: Bool = true) {
        beforeAnswer = gate
        self.holdsSignIn = holdsSignIn
    }

    var signInResult: Result<HostSession, Error> {
        get { lock.withLock { _signInResult } }
        set { lock.withLock { _signInResult = newValue } }
    }
    var eventsResult: Result<AdminEventList, Error> {
        get { lock.withLock { _eventsResult } }
        set { lock.withLock { _eventsResult = newValue } }
    }
    var signOutError: Error? {
        get { lock.withLock { _signOutError } }
        set { lock.withLock { _signOutError = newValue } }
    }
    var detailResult: Result<AdminEventDetail, Error> {
        get { lock.withLock { _detailResult } }
        set { lock.withLock { _detailResult = newValue } }
    }
    var detailCalls: [(token: String, id: String)] { lock.withLock { _detailCalls } }
    var momentsResult: Result<AdminMomentList, Error> {
        get { lock.withLock { _momentsResult } }
        set { lock.withLock { _momentsResult = newValue } }
    }
    var moderateError: Error? {
        get { lock.withLock { _moderateError } }
        set { lock.withLock { _moderateError = newValue } }
    }
    var deleteError: Error? {
        get { lock.withLock { _deleteError } }
        set { lock.withLock { _deleteError = newValue } }
    }
    /// Holds hide, show and delete requests open until opened.
    var actionGate: Gate? {
        get { lock.withLock { _actionGate } }
        set { lock.withLock { _actionGate = newValue } }
    }
    /// Holds moment list requests open until opened.
    var listGate: Gate? {
        get { lock.withLock { _listGate } }
        set { lock.withLock { _listGate = newValue } }
    }
    var listCalls: Int { lock.withLock { _listCalls } }
    var moderateCalls: [(id: String, status: AdminMoment.Status)] { lock.withLock { _moderateCalls } }
    var deleteCalls: [String] { lock.withLock { _deleteCalls } }
    var signInCalls: Int { lock.withLock { _signInCalls } }
    var signOutTokens: [String] { lock.withLock { _signOutTokens } }
    var eventTokens: [String] { lock.withLock { _eventTokens } }

    func signIn(username: String, password: String) async throws -> HostSession {
        let result = lock.withLock { _signInCalls += 1; return _signInResult }
        if holdsSignIn, let beforeAnswer { await beforeAnswer.wait() }
        try Task.checkCancellation()
        return try result.get()
    }
    func hostSessionExpiry(token: String) async throws -> Date { Date.distantFuture }
    func signOut(token: String) async throws {
        let error = lock.withLock { _signOutTokens.append(token); return _signOutError }
        if let error { throw error }
    }
    func adminEvent(token: String, id: String) async throws -> AdminEventDetail {
        let result = lock.withLock { _detailCalls.append((token, id)); return _detailResult }
        if let beforeAnswer { await beforeAnswer.wait() }
        return try result.get()
    }
    func adminMoments(token: String, eventID: String) async throws -> AdminMomentList {
        let (result, gate) = lock.withLock { _listCalls += 1; return (_momentsResult, _listGate) }
        if let gate { await gate.wait() }
        return try result.get()
    }
    func moderate(token: String, momentID: String, status: AdminMoment.Status) async throws -> AdminMoment {
        let (error, gate) = lock.withLock { _moderateCalls.append((momentID, status)); return (_moderateError, _actionGate) }
        if let gate { await gate.wait() }
        if let error { throw error }
        return adminMoment(momentID, status: status)
    }
    func deleteMoment(token: String, momentID: String) async throws {
        let (error, gate) = lock.withLock { _deleteCalls.append(momentID); return (_deleteError, _actionGate) }
        if let gate { await gate.wait() }
        if let error { throw error }
    }
    func adminEvents(token: String) async throws -> AdminEventList {
        let result = lock.withLock { _eventTokens.append(token); return _eventsResult }
        if let beforeAnswer { await beforeAnswer.wait() }
        return try result.get()
    }
}

/// A store whose writes and removals can be made to fail (keychain locked).
final class FlakyHostStore: HostSessionStore, @unchecked Sendable {
    private let lock = NSLock()
    private var session: StoredHostSession?
    private var _failSaves = false
    private var _failRemovals = false
    private var _failLoads = false
    struct Failed: Error {}

    init(_ session: StoredHostSession? = nil) { self.session = session }

    var failSaves: Bool { get { lock.withLock { _failSaves } } set { lock.withLock { _failSaves = newValue } } }
    var failRemovals: Bool { get { lock.withLock { _failRemovals } } set { lock.withLock { _failRemovals = newValue } } }
    var failLoads: Bool { get { lock.withLock { _failLoads } } set { lock.withLock { _failLoads = newValue } } }
    var stored: StoredHostSession? { lock.withLock { session } }

    func load() throws -> StoredHostSession? {
        try lock.withLock {
            if _failLoads { throw Failed() }
            return session
        }
    }
    func save(_ session: StoredHostSession) throws {
        try lock.withLock {
            if _failSaves { throw Failed() }
            self.session = session
        }
    }
    func remove() throws {
        try lock.withLock {
            if _failRemovals { throw Failed() }
            session = nil
        }
    }
}

/// A clock the test can move.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date
    init(_ value: Date) { self.value = value }
    var now: Date { lock.withLock { value } }
    func set(_ date: Date) { lock.withLock { value = date } }
}

private let start = Date(timeIntervalSince1970: 1_800_000_000)
private let later = start.addingTimeInterval(3600)
private let live = StoredHostSession(token: "hs_live", expiresAt: later)

private func session(_ token: String) -> HostSession {
    HostSession(token: token, subject: "operator", expiresAt: later)
}

private func event(_ id: String) -> AdminEvent {
    AdminEvent(
        event: Event(
            id: id, slug: id, title: "Party", type: "Party", mainCharacters: nil, description: nil,
            coverImageURL: nil, createdAt: start, startsAt: nil, expiresAt: nil, uploadsCloseAt: nil,
            purgeAfter: nil, archivedAt: nil, accessMode: .public, areUploadsOpen: true
        ),
        momentCount: 1, participantCount: 2
    )
}

@MainActor private func account(
    _ service: FakeHostService = FakeHostService(), store: any HostSessionStore = FlakyHostStore(), clock: TestClock = TestClock(start)
) -> HostAccount {
    HostAccount(service: service, store: store, now: { clock.now })
}

@Suite @MainActor struct HostAccountTests {
    @Test func startsSignedOutWithNothingStored() {
        let subject = account()
        #expect(subject.state == .signedOut && subject.currentToken() == nil)
    }

    @Test func restoresALiveSessionAndDropsAnExpiredOne() {
        let restored = account(store: FlakyHostStore(live))
        #expect(restored.state == .signedIn(expiresAt: later) && restored.currentToken() == "hs_live")

        let expiredStore = FlakyHostStore(StoredHostSession(token: "hs_old", expiresAt: start))
        let dropped = account(store: expiredStore)
        #expect(dropped.state == .signedOut && expiredStore.stored == nil)
    }

    @Test func expiryWhileOpenIsSeenByReadsAndAppliedByRefresh() {
        let clock = TestClock(start)
        let store = FlakyHostStore(live)
        let subject = account(store: store, clock: clock)
        #expect(subject.currentToken() == "hs_live")
        clock.set(later)
        // Reads never change state...
        #expect(subject.currentToken() == nil)
        #expect(subject.state == .signedIn(expiresAt: later))
        // ...refresh does.
        subject.refresh()
        #expect(subject.state == .signedOut && store.stored == nil)
    }

    @Test func aKeychainLockedAtLaunchIsReadOnRefresh() {
        let store = FlakyHostStore(live)
        store.failLoads = true
        let subject = account(store: store)
        #expect(subject.state == .signedOut)
        store.failLoads = false
        subject.refresh()
        #expect(subject.state == .signedIn(expiresAt: later))
    }

    @Test func signingInSavesTheToken() async {
        let service = FakeHostService()
        service.signInResult = .success(session("hs_new"))
        let store = FlakyHostStore()
        let subject = account(service, store: store)
        #expect(await subject.signIn(username: " admin ", password: "pw") == .signedIn)
        #expect(subject.state == .signedIn(expiresAt: later) && store.stored?.token == "hs_new")
    }

    @Test(arguments: [
        (MomentsAPIError.invalidCredentials, HostAccount.SignInFailure.invalidCredentials),
        (.tooManyAttempts(retryAfterSeconds: 900), .locked),
        (.signInUnavailable, .unavailable),
        (.upgradeRequired, .appTooOld),
        (.transport(.notConnectedToInternet), .offline),
        (.server(status: 500, code: nil), .failed),
    ])
    func mapsSignInFailures(_ error: MomentsAPIError, _ expected: HostAccount.SignInFailure) async {
        let service = FakeHostService()
        service.signInResult = .failure(error)
        let subject = account(service)
        #expect(await subject.signIn(username: "admin", password: "pw") == .failed(expected))
        #expect(subject.state == .signedOut)
    }

    @Test func aFailedSignInKeepsTheCurrentSession() async {
        let service = FakeHostService()
        service.signInResult = .failure(MomentsAPIError.invalidCredentials)
        let subject = account(service, store: FlakyHostStore(live))
        _ = await subject.signIn(username: "admin", password: "wrong")
        #expect(subject.currentToken() == "hs_live")
    }

    @Test func blankFieldsFailWithoutCalling() async {
        let service = FakeHostService()
        let subject = account(service)
        #expect(await subject.signIn(username: "  ", password: "pw") == .failed(.invalidCredentials))
        #expect(await subject.signIn(username: "admin", password: "") == .failed(.invalidCredentials))
        #expect(service.signInCalls == 0)
    }

    @Test func aSecondTapWhileSigningInIsIgnored() async {
        let gate = Gate()
        let service = FakeHostService(holding: gate)
        service.signInResult = .success(session("hs_new"))
        let subject = account(service)
        let first = Task { await subject.signIn(username: "admin", password: "pw") }
        while service.signInCalls == 0 { await Task.yield() }
        #expect(await subject.signIn(username: "admin", password: "pw") == .ignored)
        await gate.open()
        #expect(await first.value == .signedIn)
        #expect(service.signInCalls == 1)
    }

    @Test func signingOutDuringASignInDropsAndRevokesTheNewSession() async {
        let gate = Gate()
        let service = FakeHostService(holding: gate)
        service.signInResult = .success(session("hs_new"))
        let store = FlakyHostStore()
        let subject = account(service, store: store)
        let signingIn = Task { await subject.signIn(username: "admin", password: "pw") }
        while service.signInCalls == 0 { await Task.yield() }
        await subject.signOut()
        await gate.open()
        #expect(await signingIn.value == .ignored)
        #expect(subject.state == .signedOut && store.stored == nil)
        #expect(service.signOutTokens == ["hs_new"])
    }

    @Test func aCancelledSignInShowsNothing() async {
        let gate = Gate()
        let service = FakeHostService(holding: gate)
        service.signInResult = .success(session("hs_new"))
        let subject = account(service)
        let signingIn = Task { await subject.signIn(username: "admin", password: "pw") }
        while service.signInCalls == 0 { await Task.yield() }
        signingIn.cancel()
        await gate.open()
        #expect(await signingIn.value == .ignored)
        #expect(subject.state == .signedOut)
    }

    @Test func signingInAgainRevokesTheReplacedSession() async {
        let service = FakeHostService()
        service.signInResult = .success(session("hs_new"))
        let subject = account(service, store: FlakyHostStore(live))
        #expect(await subject.signIn(username: "admin", password: "pw") == .signedIn)
        #expect(subject.currentToken() == "hs_new")
        // Revoked in the background.
        while service.signOutTokens.isEmpty { await Task.yield() }
        #expect(service.signOutTokens == ["hs_live"])
    }

    @Test func aFailedSaveKeepsTheSessionForThisLaunchOnlyAndClearsTheOldOne() async {
        let service = FakeHostService()
        service.signInResult = .success(session("hs_new"))
        let store = FlakyHostStore(live)
        let subject = account(service, store: store)
        store.failSaves = true
        #expect(await subject.signIn(username: "admin", password: "pw") == .signedIn)
        #expect(subject.currentToken() == "hs_new")
        #expect(store.stored == nil)
    }

    @Test func signingOutForgetsLocallyEvenWhenTheServerFails() async {
        let service = FakeHostService()
        service.signOutError = MomentsAPIError.transport(.notConnectedToInternet)
        let store = FlakyHostStore(live)
        let subject = account(service, store: store)
        await subject.signOut()
        #expect(subject.state == .signedOut && store.stored == nil)
        #expect(service.signOutTokens == ["hs_live"])
    }

    @Test func aFailedRemovalIsRetriedByRefresh() async {
        let store = FlakyHostStore(live)
        let subject = account(store: store)
        store.failRemovals = true
        await subject.signOut()
        #expect(subject.state == .signedOut && store.stored != nil)
        store.failRemovals = false
        subject.refresh()
        #expect(store.stored == nil && subject.state == .signedOut)
    }

    @Test func aRefreshDuringASignInKeepsTheNewSession() async {
        let gate = Gate()
        let clock = TestClock(start)
        let service = FakeHostService(holding: gate)
        service.signInResult = .success(HostSession(token: "hs_new", subject: "operator", expiresAt: later.addingTimeInterval(3600)))
        let subject = account(service, store: FlakyHostStore(live), clock: clock)
        let signingIn = Task { await subject.signIn(username: "admin", password: "pw") }
        while service.signInCalls == 0 { await Task.yield() }
        // The old session expires and the app comes to the foreground.
        clock.set(later)
        subject.refresh()
        await gate.open()
        #expect(await signingIn.value == .signedIn)
        #expect(subject.currentToken() == "hs_new")
    }

    @Test func aLateEndForAnOldTokenKeepsTheNewSession() async {
        let service = FakeHostService()
        service.signInResult = .success(session("hs_new"))
        let subject = account(service, store: FlakyHostStore(live))
        _ = await subject.signIn(username: "admin", password: "pw")
        subject.sessionEnded(token: "hs_live")
        #expect(subject.currentToken() == "hs_new")
        subject.sessionEnded(token: "hs_new")
        #expect(subject.state == .signedOut)
    }
}

@Suite @MainActor struct HostEventsModelTests {
    @Test func loadsWithTheStoredToken() async {
        let service = FakeHostService()
        service.eventsResult = .success(AdminEventList(events: [event("a"), event("b")], isTruncated: true))
        let model = HostEventsModel(service: service, account: account(service, store: FlakyHostStore(live)))
        await model.load()
        #expect(model.phase == .loaded && model.events.map(\.id) == ["a", "b"] && model.isTruncated)
        #expect(service.eventTokens == ["hs_live"])
    }

    @Test func aDeadSessionSignsTheHostOut() async {
        let service = FakeHostService()
        service.eventsResult = .failure(MomentsAPIError.hostAuthRequired)
        let host = account(service, store: FlakyHostStore(live))
        let model = HostEventsModel(service: service, account: host)
        await model.load()
        #expect(host.state == .signedOut && model.phase == .idle && model.events.isEmpty)
    }

    @Test func signingOutDuringALoadDropsTheAnswer() async {
        let gate = Gate()
        let service = FakeHostService(holding: gate)
        service.eventsResult = .success(AdminEventList(events: [event("a")], isTruncated: true))
        let host = account(service, store: FlakyHostStore(live))
        let model = HostEventsModel(service: service, account: host)
        let loading = Task { await model.load() }
        while service.eventTokens.isEmpty { await Task.yield() }
        await host.signOut()
        await gate.open()
        await loading.value
        #expect(model.events.isEmpty && !model.isTruncated && model.phase == .idle)
    }

    @Test func signingInAgainDuringALoadLoadsForTheNewSession() async {
        let gate = Gate()
        let service = FakeHostService(holding: gate, holdsSignIn: false)
        service.eventsResult = .success(AdminEventList(events: [event("a")], isTruncated: false))
        service.signInResult = .success(HostSession(token: "hs_new", subject: "operator", expiresAt: later))
        let host = account(service, store: FlakyHostStore(live))
        let model = HostEventsModel(service: service, account: host)
        let loading = Task { await model.load() }
        while service.eventTokens.isEmpty { await Task.yield() }
        await host.signOut()
        _ = await host.signIn(username: "admin", password: "pw")
        await gate.open()
        await loading.value
        #expect(service.eventTokens == ["hs_live", "hs_new"])
        #expect(model.phase == .loaded && model.events.map(\.id) == ["a"])
    }

    @Test func aFailureKeepsTheLastList() async {
        let service = FakeHostService()
        service.eventsResult = .success(AdminEventList(events: [event("a")], isTruncated: false))
        let model = HostEventsModel(service: service, account: account(service, store: FlakyHostStore(live)))
        await model.load()
        service.eventsResult = .failure(MomentsAPIError.transport(.timedOut))
        await model.load()
        #expect(model.phase == .failed(.offline) && model.events.map(\.id) == ["a"])
    }

    @Test func resetForgetsTheList() async {
        let service = FakeHostService()
        service.eventsResult = .success(AdminEventList(events: [event("a")], isTruncated: true))
        let model = HostEventsModel(service: service, account: account(service, store: FlakyHostStore(live)))
        await model.load()
        model.reset()
        #expect(model.events.isEmpty && !model.isTruncated && model.phase == .idle)
    }

    @Test func signedOutLoadsNothing() async {
        let service = FakeHostService()
        let model = HostEventsModel(service: service, account: account(service))
        await model.load()
        #expect(model.phase == .idle && service.eventTokens.isEmpty)
    }

    @Test func anExpiredSessionIsDroppedBeforeLoading() async {
        let clock = TestClock(start)
        let service = FakeHostService()
        let host = account(service, store: FlakyHostStore(live), clock: clock)
        let model = HostEventsModel(service: service, account: host)
        clock.set(later)
        await model.load()
        #expect(host.state == .signedOut && service.eventTokens.isEmpty)
    }
}

private func detail(_ id: String) -> AdminEventDetail {
    AdminEventDetail(
        summary: event(id),
        share: EventShareLinks(eventURL: URL(string: "https://moments.test/e/\(id)")!, inviteURL: nil),
        analytics: EventAnalytics(
            totalMoments: 1, hiddenMoments: 0, photos: 1, videos: 0, storageBytes: 10,
            participants: 2, reactions: 3, activity: []
        )
    )
}

@Suite @MainActor struct HostEventDetailModelTests {
    @Test func loadsTheEventWithTheStoredToken() async {
        let service = FakeHostService()
        service.detailResult = .success(detail("a"))
        let model = HostEventDetailModel(eventID: "a", service: service, account: account(service, store: FlakyHostStore(live)))
        await model.load()
        #expect(model.phase == .loaded && model.detail == detail("a"))
        #expect(service.detailCalls.map(\.token) == ["hs_live"] && service.detailCalls.map(\.id) == ["a"])
    }

    @Test func aDeletedEventIsGone() async {
        let service = FakeHostService()
        service.detailResult = .success(detail("a"))
        let model = HostEventDetailModel(eventID: "a", service: service, account: account(service, store: FlakyHostStore(live)))
        await model.load()
        service.detailResult = .failure(MomentsAPIError.eventNotFound)
        await model.load()
        #expect(model.phase == .gone && model.detail == nil)
    }

    @Test func aFailureKeepsTheLastDetail() async {
        let service = FakeHostService()
        service.detailResult = .success(detail("a"))
        let model = HostEventDetailModel(eventID: "a", service: service, account: account(service, store: FlakyHostStore(live)))
        await model.load()
        service.detailResult = .failure(MomentsAPIError.upgradeRequired)
        await model.load()
        #expect(model.phase == .failed(.appTooOld) && model.detail == detail("a"))
    }

    @Test func aDeadSessionSignsTheHostOutAndClears() async {
        let service = FakeHostService()
        service.detailResult = .failure(MomentsAPIError.hostAuthRequired)
        let host = account(service, store: FlakyHostStore(live))
        let model = HostEventDetailModel(eventID: "a", service: service, account: host)
        await model.load()
        #expect(host.state == .signedOut && model.phase == .idle && model.detail == nil)
    }

    @Test func signingOutDuringALoadDropsTheAnswer() async {
        let gate = Gate()
        let service = FakeHostService(holding: gate)
        service.detailResult = .success(detail("a"))
        let host = account(service, store: FlakyHostStore(live))
        let model = HostEventDetailModel(eventID: "a", service: service, account: host)
        let loading = Task { await model.load() }
        while service.detailCalls.isEmpty { await Task.yield() }
        await host.signOut()
        await gate.open()
        await loading.value
        #expect(model.detail == nil && model.phase == .idle)
    }

    @Test func signedOutLoadsNothing() async {
        let service = FakeHostService()
        let model = HostEventDetailModel(eventID: "a", service: service, account: account(service))
        await model.load()
        #expect(model.phase == .idle && service.detailCalls.isEmpty)
    }

    @Test func signingInAgainDuringALoadLoadsForTheNewSession() async {
        let gate = Gate()
        let service = FakeHostService(holding: gate, holdsSignIn: false)
        service.detailResult = .success(detail("a"))
        service.signInResult = .success(HostSession(token: "hs_new", subject: "operator", expiresAt: later))
        let host = account(service, store: FlakyHostStore(live))
        let model = HostEventDetailModel(eventID: "a", service: service, account: host)
        let loading = Task { await model.load() }
        while service.detailCalls.isEmpty { await Task.yield() }
        await host.signOut()
        _ = await host.signIn(username: "admin", password: "pw")
        await gate.open()
        await loading.value
        #expect(service.detailCalls.map(\.token) == ["hs_live", "hs_new"])
        #expect(model.phase == .loaded && model.detail == detail("a"))
    }

    @Test func aCancelledLoadKeepsWhatWasShown() async {
        let gate = Gate()
        let service = FakeHostService(holding: gate)
        service.detailResult = .failure(CancellationError())
        let model = HostEventDetailModel(eventID: "a", service: service, account: account(service, store: FlakyHostStore(live)))
        await gate.open()
        await model.load()
        #expect(model.phase == .idle && model.detail == nil)
        service.detailResult = .success(detail("a"))
        await model.load()
        service.detailResult = .failure(CancellationError())
        await model.load()
        #expect(model.phase == .loaded && model.detail == detail("a"))
    }
}

func adminMoment(_ id: String, status: AdminMoment.Status = .approved) -> AdminMoment {
    AdminMoment(
        id: id, eventID: "a", uploaderName: "Sara", createdAt: Date(timeIntervalSince1970: 1_800_000_000),
        status: status, media: Media(kind: .image, url: "https://moments.test/media/\(id).jpg")
    )
}

@Suite @MainActor struct HostModerationModelTests {
    private func loaded(
        _ moments: [AdminMoment] = [adminMoment("m1"), adminMoment("m2", status: .hidden)]
    ) async -> (HostModerationModel, FakeHostService, HostAccount) {
        let service = FakeHostService()
        service.momentsResult = .success(AdminMomentList(moments: moments, isTruncated: false))
        let host = account(service, store: FlakyHostStore(live))
        let model = HostModerationModel(eventID: "a", service: service, account: host)
        await model.load()
        return (model, service, host)
    }

    @Test func loadsTheMomentsAndCountsTheHiddenOnes() async {
        let (model, _, _) = await loaded()
        #expect(model.phase == .loaded && model.moments.map(\.id) == ["m1", "m2"] && model.hiddenCount == 1)
    }

    @Test func aDeletedEventIsGone() async {
        let (model, service, _) = await loaded()
        service.momentsResult = .failure(MomentsAPIError.eventNotFound)
        await model.load()
        #expect(model.phase == .gone && model.moments.isEmpty)
    }

    @Test func hidingShowsRightAwayAndKeepsTheServersAnswer() async {
        let (model, service, _) = await loaded()
        let gate = Gate()
        service.actionGate = gate
        let hiding = Task { await model.setHidden(true, momentID: "m1") }
        while service.moderateCalls.isEmpty { await Task.yield() }
        #expect(model.moments[0].isHidden && model.pendingIDs == ["m1"])
        await gate.open()
        await hiding.value
        #expect(model.moments[0].isHidden && model.pendingIDs.isEmpty && model.actionFailure == nil)
        #expect(service.moderateCalls.map(\.status) == [.hidden])
    }

    @Test func aFailedHideIsUndoneAndExplained() async {
        let (model, service, _) = await loaded()
        service.moderateError = MomentsAPIError.transport(.notConnectedToInternet)
        await model.setHidden(true, momentID: "m1")
        #expect(!model.moments[0].isHidden && model.actionFailure == .offline)
        model.dismissActionFailure()
        #expect(model.actionFailure == nil)
    }

    @Test func showingAMomentThatIsAlreadyVisibleSendsNothing() async {
        let (model, service, _) = await loaded()
        await model.setHidden(false, momentID: "m1")
        await model.setHidden(true, momentID: "unknown")
        #expect(service.moderateCalls.isEmpty)
    }

    @Test func aSecondTapWhileOneIsOnItsWayIsIgnored() async {
        let (model, service, _) = await loaded()
        let gate = Gate()
        service.actionGate = gate
        let hiding = Task { await model.setHidden(true, momentID: "m1") }
        while service.moderateCalls.isEmpty { await Task.yield() }
        await model.delete(momentID: "m1")
        await gate.open()
        await hiding.value
        #expect(service.deleteCalls.isEmpty && model.moments.count == 2)
    }

    @Test func aMomentDeletedElsewhereLeavesTheList() async {
        let (model, service, _) = await loaded()
        service.moderateError = MomentsAPIError.momentNotFound
        await model.setHidden(true, momentID: "m1")
        #expect(model.moments.map(\.id) == ["m2"] && model.actionFailure == nil)
    }

    @Test func deletingRemovesOnlyOnceTheServerConfirms() async {
        let (model, service, _) = await loaded()
        let gate = Gate()
        service.actionGate = gate
        let deleting = Task { await model.delete(momentID: "m2") }
        while service.deleteCalls.isEmpty { await Task.yield() }
        #expect(model.moments.map(\.id) == ["m1", "m2"] && model.pendingIDs == ["m2"])
        await gate.open()
        await deleting.value
        #expect(model.moments.map(\.id) == ["m1"] && model.pendingIDs.isEmpty)
    }

    @Test func filesThatCouldntBeDeletedKeepTheMoment() async {
        let (model, service, _) = await loaded()
        service.deleteError = MomentsAPIError.mediaDeleteFailed
        await model.delete(momentID: "m1")
        #expect(model.moments.count == 2 && model.actionFailure == .mediaKept)
    }

    @Test func anAlreadyDeletedMomentLeavesTheList() async {
        let (model, service, _) = await loaded()
        service.deleteError = MomentsAPIError.momentNotFound
        await model.delete(momentID: "m1")
        #expect(model.moments.map(\.id) == ["m2"] && model.actionFailure == nil)
    }

    @Test func aDeadSessionDuringAnActionSignsOutAndClears() async {
        let (model, service, host) = await loaded()
        service.deleteError = MomentsAPIError.hostAuthRequired
        await model.delete(momentID: "m1")
        #expect(host.state == .signedOut && model.moments.isEmpty && model.phase == .idle)
    }

    @Test func aReloadDuringAFailedHideWins() async {
        let (model, service, _) = await loaded()
        let gate = Gate()
        service.actionGate = gate
        service.moderateError = MomentsAPIError.server(status: 500, code: nil)
        let hiding = Task { await model.setHidden(true, momentID: "m1") }
        while service.moderateCalls.isEmpty { await Task.yield() }
        // Hidden on another device meanwhile: the reload shows it hidden.
        service.momentsResult = .success(AdminMomentList(moments: [adminMoment("m1", status: .hidden)], isTruncated: false))
        await model.load()
        await gate.open()
        await hiding.value
        #expect(model.moments[0].isHidden && model.actionFailure == .failed)
    }

    @Test func aLoadThatStartedBeforeADeleteDoesntBringItBack() async {
        let (model, service, _) = await loaded()
        let gate = Gate()
        service.listGate = gate
        let reloading = Task { await model.load() }
        while service.listCalls < 2 { await Task.yield() }
        // The server still listed m1 when this load started.
        await model.delete(momentID: "m1")
        service.momentsResult = .success(AdminMomentList(moments: [adminMoment("m2", status: .hidden)], isTruncated: false))
        await gate.open()
        await reloading.value
        #expect(model.moments.map(\.id) == ["m2"] && service.listCalls == 3)
    }

    @Test func anActionFromBeforeAResetDoesntTouchANewOne() async {
        let (model, service, _) = await loaded()
        let gate = Gate()
        service.actionGate = gate
        let old = Task { await model.setHidden(true, momentID: "m1") }
        while service.moderateCalls.isEmpty { await Task.yield() }
        model.reset()
        await model.load()
        let newGate = Gate()
        service.actionGate = newGate
        let new = Task { await model.delete(momentID: "m1") }
        while service.deleteCalls.isEmpty { await Task.yield() }
        await gate.open()
        await old.value
        // The old answer is dropped and the delete is still marked as on its way.
        #expect(model.pendingIDs == ["m1"] && !model.moments[0].isHidden)
        await newGate.open()
        await new.value
        #expect(model.moments.map(\.id) == ["m2"] && model.pendingIDs.isEmpty)
    }

    @Test func aResetDuringALoadDropsItsAnswer() async {
        let (model, service, _) = await loaded()
        let gate = Gate()
        service.listGate = gate
        let reloading = Task { await model.load() }
        while service.listCalls < 2 { await Task.yield() }
        model.reset()
        await gate.open()
        await reloading.value
        #expect(model.moments.isEmpty && model.phase == .idle)
    }

    @Test func anOfflineDeleteKeepsTheMomentAndSaysSo() async {
        let (model, service, _) = await loaded()
        service.deleteError = MomentsAPIError.transport(.notConnectedToInternet)
        await model.delete(momentID: "m1")
        #expect(model.moments.count == 2 && model.actionFailure == .offline && model.pendingIDs.isEmpty)
    }

    @Test func actionsOnDifferentMomentsRunSideBySide() async {
        let (model, service, _) = await loaded()
        let gate = Gate()
        service.actionGate = gate
        let hiding = Task { await model.setHidden(true, momentID: "m1") }
        let deleting = Task { await model.delete(momentID: "m2") }
        while service.moderateCalls.isEmpty || service.deleteCalls.isEmpty { await Task.yield() }
        #expect(model.pendingIDs == ["m1", "m2"])
        await gate.open()
        await hiding.value
        await deleting.value
        #expect(model.moments.map(\.id) == ["m1"] && model.moments[0].isHidden && model.pendingIDs.isEmpty)
    }
}
