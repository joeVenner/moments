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
