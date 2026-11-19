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
    private var _saveResult: Result<AdminEventDetail, Error> = .failure(MomentsAPIError.eventNotFound)
    private var _saveCalls: [String] = []
    private var _saveGate: Gate?
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
    var saveResult: Result<AdminEventDetail, Error> {
        get { lock.withLock { _saveResult } }
        set { lock.withLock { _saveResult = newValue } }
    }
    var saveGate: Gate? {
        get { lock.withLock { _saveGate } }
        set { lock.withLock { _saveGate = newValue } }
    }
    /// One line per create/edit/access/dates call, e.g. "access e1 private 123456".
    var saveCalls: [String] { lock.withLock { _saveCalls } }
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
    private func save(_ call: String) async throws -> AdminEventDetail {
        let (result, gate) = lock.withLock { _saveCalls.append(call); return (_saveResult, _saveGate) }
        if let gate { await gate.wait() }
        return try result.get()
    }
    func createEvent(token: String, details: EventDetails, endsAt: Date?) async throws -> AdminEventDetail {
        try await save("create \(details.title)|\(details.type)|\(details.mainCharacters ?? "-")|\(details.description ?? "-") ends:\(endsAt != nil)")
    }
    func updateEvent(token: String, id: String, details: EventDetails) async throws -> AdminEventDetail {
        try await save("update \(id) \(details.title)|\(details.type)|\(details.mainCharacters ?? "-")|\(details.description ?? "-")")
    }
    func updateAccess(token: String, id: String, mode: Event.AccessMode, newPIN: String?) async throws -> AdminEventDetail {
        try await save("access \(id) \(mode.rawValue) \(newPIN ?? "-")")
    }
    func updateDates(token: String, id: String, uploadsCloseAt: Date?, deleteAfter: Date?) async throws -> AdminEventDetail {
        try await save("dates \(id) close:\(uploadsCloseAt != nil) delete:\(deleteAfter != nil)")
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
    @Test func showsASavedEventWithoutFetching() {
        let service = FakeHostService()
        let model = HostEventDetailModel(eventID: "a", service: service, account: account(service, store: FlakyHostStore(live)))
        model.apply(detail("b"))
        #expect(model.detail == nil)
        model.apply(detail("a"))
        #expect(model.phase == .loaded && model.detail == detail("a") && service.detailCalls.isEmpty)
    }

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


private func plainEvent(_ id: String, mode: Event.AccessMode = .public, close: Date? = nil, purge: Date? = nil) -> Event {
    Event(
        id: id, slug: id, title: "Party", type: "Party", mainCharacters: "Sara", description: nil,
        coverImageURL: nil, createdAt: start, startsAt: nil, expiresAt: nil, uploadsCloseAt: close,
        purgeAfter: purge, archivedAt: nil, accessMode: mode, areUploadsOpen: true
    )
}

@Suite struct EventFormTests {
    @Test func aNewFormNeedsATitleAndType() {
        #expect(EventForm().problems(now: start) == [.titleMissing, .typeMissing])
    }

    @Test func trimsTextAndTreatsBlankOptionalTextAsNone() {
        var form = EventForm()
        form.title = "  Sara & Omar  "
        form.type = "Wedding\n"
        form.mainCharacters = "   "
        form.description = " Welcome "
        #expect(form.problems(now: start).isEmpty)
        #expect(form.details == EventDetails(title: "Sara & Omar", type: "Wedding", mainCharacters: nil, description: "Welcome"))
    }

    @Test func countsLengthsLikeTheServer() {
        var form = EventForm()
        // 60 emoji are 120 UTF-16 units: the most a title may have.
        form.title = String(repeating: "🎉", count: 60)
        form.type = String(repeating: "x", count: 61)
        form.mainCharacters = String(repeating: "x", count: 201)
        form.description = String(repeating: "x", count: 1001)
        #expect(form.problems(now: start) == [.typeTooLong, .mainCharactersTooLong, .descriptionTooLong])
        form.title += "a"
        #expect(form.problems(now: start).contains(.titleTooLong))
    }

    @Test func anEndMustBeAheadAndAfterTheStart() {
        var form = EventForm()
        form.title = "Party"
        form.type = "Party"
        form.endsAt = start
        #expect(form.problems(now: start) == [.endInPast])
        form.endsAt = later
        form.startsAt = later.addingTimeInterval(60)
        #expect(form.problems(now: start) == [.endBeforeStart])
    }

    @Test func theEditFormStartsFromTheEvent() {
        let form = EventForm(event: plainEvent("e1"))
        #expect(form.title == "Party" && form.mainCharacters == "Sara" && form.description.isEmpty && form.endsAt == nil)
    }
}

@Suite @MainActor struct HostEventFormModelTests {
    @Test func createsTheEventOnce() async {
        let service = FakeHostService()
        service.saveResult = .success(detail("new"))
        let model = HostEventFormModel(service: service, account: account(service, store: FlakyHostStore(live)))
        model.form.title = " Party "
        model.form.type = "Party"
        await model.save(now: start)
        #expect(model.phase == .saved(detail("new")))
        #expect(service.saveCalls == ["create Party|Party|-|- ends:false"])
    }

    @Test func doesNothingWhileTheFormHasProblems() async {
        let service = FakeHostService()
        let model = HostEventFormModel(service: service, account: account(service, store: FlakyHostStore(live)))
        await model.save(now: start)
        #expect(model.phase == .editing && service.saveCalls.isEmpty)
    }

    @Test func editsTheEventByID() async {
        let service = FakeHostService()
        service.saveResult = .success(detail("e1"))
        let model = HostEventFormModel(editing: plainEvent("e1"), service: service, account: account(service, store: FlakyHostStore(live)))
        model.form.mainCharacters = ""
        await model.save(now: start)
        #expect(service.saveCalls == ["update e1 Party|Party|-|-"])
        #expect(model.phase == .saved(detail("e1")))
    }

    @Test(arguments: [
        (MomentsAPIError.rateLimited, HostSaveFailure.rateLimited),
        (.invalidRequest, .refused),
        (.eventNotFound, .gone),
        (.transport(.notConnectedToInternet), .offline),
        (.upgradeRequired, .appTooOld),
        (.server(status: 500, code: nil), .failed),
    ])
    func showsWhySavingFailed(_ error: MomentsAPIError, _ expected: HostSaveFailure) async {
        let service = FakeHostService()
        service.saveResult = .failure(error)
        let model = HostEventFormModel(editing: plainEvent("e1"), service: service, account: account(service, store: FlakyHostStore(live)))
        await model.save(now: start)
        #expect(model.phase == .failed(expected))
        model.dismissFailure()
        #expect(model.phase == .editing)
    }

    @Test func anEditFormHasChangesOnlyWhenTheStoredDetailsDiffer() {
        let service = FakeHostService()
        let model = HostEventFormModel(editing: plainEvent("e1"), service: service, account: account(service, store: FlakyHostStore(live)))
        #expect(!model.hasChanges)
        model.form.title += "  "
        #expect(!model.hasChanges)
        model.form.title = "Another party"
        #expect(model.hasChanges)
    }

    @Test func aSavedFormNeverCreatesAgain() async {
        let service = FakeHostService()
        service.saveResult = .success(detail("new"))
        let model = HostEventFormModel(service: service, account: account(service, store: FlakyHostStore(live)))
        model.form.title = "Party"
        model.form.type = "Party"
        await model.save(now: start)
        await model.save(now: start)
        #expect(service.saveCalls.count == 1)
    }

    @Test func aBlankTitleIncludesTheInvisibleSpaceJSTrims() {
        var form = EventForm()
        form.title = "\u{FEFF} "
        form.type = "Party"
        #expect(form.problems(now: start) == [.titleMissing])
    }

    @Test func anUnclearCreateFailureSaysTheEventMayExist() async {
        let service = FakeHostService()
        service.saveResult = .failure(MomentsAPIError.transport(.timedOut))
        let model = HostEventFormModel(service: service, account: account(service, store: FlakyHostStore(live)))
        model.form.title = "Party"
        model.form.type = "Party"
        await model.save(now: start)
        #expect(model.phase == .failed(.offline) && model.mayHaveCreated)
        let refused = HostEventFormModel(service: service, account: account(service, store: FlakyHostStore(live)))
        refused.form = model.form
        service.saveResult = .failure(MomentsAPIError.rateLimited)
        await refused.save(now: start)
        #expect(refused.phase == .failed(.rateLimited) && !refused.mayHaveCreated)
    }

    @Test func aDeadSessionSignsOut() async {
        let service = FakeHostService()
        service.saveResult = .failure(MomentsAPIError.hostAuthRequired)
        let host = account(service, store: FlakyHostStore(live))
        let model = HostEventFormModel(service: service, account: host)
        model.form.title = "Party"
        model.form.type = "Party"
        await model.save(now: start)
        #expect(model.phase == .signedOut && host.state == .signedOut)
        #expect(service.saveCalls.count == 1)
    }

    @Test func aSecondTapWhileSavingIsIgnored() async {
        let service = FakeHostService()
        let gate = Gate()
        service.saveGate = gate
        service.saveResult = .success(detail("new"))
        let model = HostEventFormModel(service: service, account: account(service, store: FlakyHostStore(live)))
        model.form.title = "Party"
        model.form.type = "Party"
        let first = Task { await model.save(now: start) }
        while service.saveCalls.isEmpty { await Task.yield() }
        await model.save(now: start)
        await gate.open()
        await first.value
        #expect(service.saveCalls.count == 1 && model.phase == .saved(detail("new")))
    }
}

@Suite @MainActor struct HostEventAccessModelTests {
    @Test func goingPrivateNeedsAPINAndSignsGuestsOut() async {
        let service = FakeHostService()
        service.saveResult = .success(detail("e1"))
        let model = HostEventAccessModel(event: plainEvent("e1"), service: service, account: account(service, store: FlakyHostStore(live)))
        #expect(!model.hasChanges && model.problems.isEmpty)
        model.mode = .private
        #expect(model.problems == [.pinRequired] && model.signsGuestsOut)
        await model.save()
        #expect(service.saveCalls.isEmpty)
        model.newPIN = " 482913 "
        await model.save()
        #expect(service.saveCalls == ["access e1 private 482913"])
        #expect(model.phase == .saved(detail("e1")) && model.newPIN.isEmpty)
    }

    @Test func aPrivateEventKeepsItsPINWhenNoneIsTyped() async {
        let service = FakeHostService()
        service.saveResult = .success(detail("e1"))
        let model = HostEventAccessModel(event: plainEvent("e1", mode: .private), service: service, account: account(service, store: FlakyHostStore(live)))
        #expect(model.problems.isEmpty && !model.signsGuestsOut && !model.hasChanges)
        model.mode = .public
        #expect(!model.signsGuestsOut)
        await model.save()
        #expect(service.saveCalls == ["access e1 public -"])
    }

    @Test func forgetsThePINWhenTheEventIsGoneButKeepsItForARetry() async {
        let service = FakeHostService()
        service.saveResult = .failure(MomentsAPIError.transport(.notConnectedToInternet))
        let model = HostEventAccessModel(event: plainEvent("e1", mode: .private), service: service, account: account(service, store: FlakyHostStore(live)))
        model.newPIN = "482913"
        await model.save()
        #expect(model.newPIN == "482913")
        model.dismissFailure()
        service.saveResult = .failure(MomentsAPIError.eventNotFound)
        await model.save()
        #expect(model.phase == .failed(.gone) && model.newPIN.isEmpty)
        model.dismissFailure()
        #expect(model.phase == .failed(.gone))
    }

    @Test func aPublicEventNeverSendsAPIN() async {
        let service = FakeHostService()
        service.saveResult = .success(detail("e1"))
        let model = HostEventAccessModel(event: plainEvent("e1", mode: .private), service: service, account: account(service, store: FlakyHostStore(live)))
        #expect(model.keepsCurrentPIN)
        model.newPIN = "12"
        model.mode = .public
        #expect(model.problems.isEmpty && !model.signsGuestsOut)
        await model.save()
        #expect(service.saveCalls == ["access e1 public -"])
    }

    @Test func keepsADifferentPINTypedWhileSaving() async {
        let service = FakeHostService()
        let gate = Gate()
        service.saveGate = gate
        service.saveResult = .success(detail("e1"))
        let model = HostEventAccessModel(event: plainEvent("e1", mode: .private), service: service, account: account(service, store: FlakyHostStore(live)))
        model.newPIN = "111111"
        let saving = Task { await model.save() }
        while service.saveCalls.isEmpty { await Task.yield() }
        model.newPIN = "222222"
        await gate.open()
        await saving.value
        #expect(model.newPIN == "222222" && service.saveCalls == ["access e1 private 111111"])
    }

    @Test func checksThePINLength() {
        let service = FakeHostService()
        let model = HostEventAccessModel(event: plainEvent("e1", mode: .private), service: service, account: account(service))
        model.newPIN = "12345"
        #expect(model.problems == [.pinTooShort])
        model.newPIN = String(repeating: "1", count: 21)
        #expect(model.problems == [.pinTooLong])
        model.newPIN = "123456"
        #expect(model.problems.isEmpty && model.signsGuestsOut)
    }

    @Test func neverPrintsThePIN() {
        let service = FakeHostService()
        let model = HostEventAccessModel(event: plainEvent("e1"), service: service, account: account(service))
        model.mode = .private
        model.newPIN = "482913"
        #expect(model.signsGuestsOut)
        #expect(!String(describing: model.phase).contains("482913"))
    }
}

@Suite @MainActor struct HostEventDatesModelTests {
    @Test func startsFromTheEffectiveDates() {
        let service = FakeHostService()
        let event = Event(
            id: "e1", slug: "e1", title: "Party", type: "Party", mainCharacters: nil, description: nil,
            coverImageURL: nil, createdAt: start, startsAt: nil, expiresAt: later, uploadsCloseAt: nil,
            purgeAfter: nil, archivedAt: nil, accessMode: .public, areUploadsOpen: true
        )
        let model = HostEventDatesModel(event: event, service: service, account: account(service))
        #expect(model.uploadsCloseAt == later && model.deleteAfter == later)
    }

    @Test func refusesADeletionInThePastOrBeforeUploadsClose() async {
        let service = FakeHostService()
        let model = HostEventDatesModel(event: plainEvent("e1"), service: service, account: account(service, store: FlakyHostStore(live)))
        model.deleteAfter = start
        #expect(model.problems(now: start) == [.deleteInPast])
        model.deleteAfter = later
        model.uploadsCloseAt = later.addingTimeInterval(1)
        #expect(model.problems(now: start) == [.closeAfterDelete])
        await model.save(now: start)
        #expect(service.saveCalls.isEmpty)
    }

    @Test func anUntouchedFormNeverSaves() async {
        let service = FakeHostService()
        service.saveResult = .success(detail("e1"))
        let model = HostEventDatesModel(event: plainEvent("e1", close: later), service: service, account: account(service, store: FlakyHostStore(live)))
        #expect(!model.hasChanges)
        await model.save(now: start)
        #expect(service.saveCalls.isEmpty && model.phase == .editing)
    }

    @Test func closesUploadsNowWithAPastDateAndSavesBoth() async {
        let service = FakeHostService()
        service.saveResult = .success(detail("e1"))
        let model = HostEventDatesModel(event: plainEvent("e1"), service: service, account: account(service, store: FlakyHostStore(live)))
        model.uploadsCloseAt = start.addingTimeInterval(-60)
        #expect(model.problems(now: start).isEmpty)
        await model.save(now: start)
        #expect(service.saveCalls == ["dates e1 close:true delete:false"] && model.phase == .saved(detail("e1")))
    }
}
