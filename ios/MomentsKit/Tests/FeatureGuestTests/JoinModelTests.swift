import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import FeatureGuest

private let slug = EventSlug("party")!
private let invite = InviteToken(String(repeating: "ab12", count: 16))!
private let future = Date(timeIntervalSince1970: 4_000_000_000)
private let privateEvent = Event(id: "e1", slug: "party", title: "Party", type: "party", createdAt: .distantPast, accessMode: .private)
private let publicEvent = Event(id: "e1", slug: "party", title: "Party", type: "party", createdAt: .distantPast)
private let guest = Participant(id: "p1", eventID: "e1", nickname: "Lea", joinedAt: .distantPast)

@MainActor
private func makeModel(invite: InviteToken? = nil, store: InMemoryEventCredentialStore = .init()) -> (JoinModel, FakeService, InMemoryEventCredentialStore) {
    let service = FakeService()
    return (JoinModel(slug: slug, invite: invite, service: service, store: store), service, store)
}

@Suite @MainActor struct JoinModelTests {
    @Test func publicEventGoesStraightToNickname() async {
        let (model, service, _) = makeModel()
        service.eventResults = [.success(publicEvent)]
        await model.start()
        #expect(model.phase == .needsNickname(publicEvent, nil))
        #expect(service.accessCalls.isEmpty)
    }

    @Test func inviteUnlocksThenGrantIsStoredUnderTheEventID() async throws {
        let (model, service, store) = makeModel(invite: invite)
        service.accessResults = [.success(AccessGrant(token: "grant", expiresAt: future))]
        service.eventResults = [.success(privateEvent)]
        await model.start()
        #expect(service.accessCalls == [.invite(invite.value)])
        #expect(service.eventCalls.first?.accessGrant == "grant")
        #expect(model.phase == .needsNickname(privateEvent, nil))
        let stored = try #require(store.credentials(for: slug))
        #expect(stored.eventID == "e1" && stored.accessGrant == "grant" && stored.accessGrantExpiresAt == future)
    }

    @Test func freshGrantReplacesAnEntryFromAReusedSlug() async throws {
        let store = InMemoryEventCredentialStore([slug: StoredEventCredentials(eventID: "old", guestToken: "old-token", participantID: "p0", nickname: "Old")])
        let (model, service, _) = makeModel(invite: invite, store: store)
        service.accessResults = [.success(AccessGrant(token: "grant", expiresAt: future))]
        service.eventResults = [.success(privateEvent)]
        await model.start()
        #expect(model.phase == .needsNickname(privateEvent, nil))
        let stored = try #require(store.credentials(for: slug))
        #expect(stored.eventID == "e1" && stored.accessGrant == "grant" && stored.guestToken == nil)
    }

    @Test func rejectedInviteAsksForThePIN() async {
        let (model, service, _) = makeModel(invite: invite)
        service.accessResults = [.failure(MomentsAPIError.invalidAccess)]
        await model.start()
        #expect(model.phase == .needsAccess(.inviteRejected))
        #expect(service.eventCalls.isEmpty)
    }

    @Test func pinFlowReportsWrongPINAndLockout() async {
        let (model, service, _) = makeModel()
        service.eventResults = [.failure(MomentsAPIError.accessRequired), .success(privateEvent)]
        await model.start()
        #expect(model.phase == .needsAccess(nil))

        service.accessResults = [
            .failure(MomentsAPIError.invalidAccess),
            .failure(MomentsAPIError.tooManyAttempts(retryAfterSeconds: 900)),
            .success(AccessGrant(token: "grant", expiresAt: future)),
        ]
        await model.submitPIN(" 1234 ")
        #expect(model.phase == .needsAccess(.wrongPIN))
        #expect(service.accessCalls == [.pin("1234")])
        await model.submitPIN("123456")
        #expect(model.phase == .needsAccess(.tooManyAttempts(retryAfterSeconds: 900)))
        await model.submitPIN("654321")
        #expect(model.phase == .needsNickname(privateEvent, nil))
        await model.submitPIN("   ")
        #expect(service.accessCalls.count == 3)
    }

    @Test func revokedStoredGrantIsDroppedAndThePINIsAsked() async throws {
        let store = InMemoryEventCredentialStore([slug: StoredEventCredentials(eventID: "e1", accessGrant: "old", accessGrantExpiresAt: future, guestToken: "gt")])
        let (model, service, _) = makeModel(store: store)
        service.eventResults = [.failure(MomentsAPIError.accessRequired)]
        await model.start()
        #expect(service.eventCalls.first?.accessGrant == "old")
        #expect(model.phase == .needsAccess(nil))
        let stored = try #require(store.credentials(for: slug))
        #expect(stored.accessGrant == nil && stored.guestToken == "gt")
    }

    @Test func joinStoresTokenAndParticipant() async throws {
        let (model, service, store) = makeModel()
        service.eventResults = [.success(publicEvent)]
        service.joinResults = [
            .failure(MomentsAPIError.nicknameTaken),
            .success(JoinResult(participant: guest, guestToken: "gt_new")),
        ]
        await model.start()
        await model.join(nickname: "  ")
        #expect(model.phase == .needsNickname(publicEvent, .invalid))
        await model.join(nickname: String(repeating: "a", count: 61))
        #expect(model.phase == .needsNickname(publicEvent, .invalid))
        await model.join(nickname: "Lea")
        #expect(model.phase == .needsNickname(publicEvent, .taken))
        await model.join(nickname: " Lea ")
        #expect(model.phase == .joined(publicEvent, guest))
        #expect(service.joinCalls.map(\.nickname) == ["Lea", "Lea"])
        let stored = try #require(store.credentials(for: slug))
        #expect(stored.guestToken == "gt_new" && stored.participantID == "p1" && stored.nickname == "Lea" && stored.eventID == "e1")
    }

    @Test func returningGuestIsConfirmedWithTheServer() async {
        let store = InMemoryEventCredentialStore([slug: StoredEventCredentials(eventID: "e1", guestToken: "gt", participantID: "p1", nickname: "Lea")])
        let (model, service, _) = makeModel(store: store)
        service.eventResults = [.success(publicEvent)]
        service.joinResults = [.success(JoinResult(participant: guest, guestToken: nil))]
        await model.start()
        #expect(model.phase == .joined(publicEvent, guest))
        #expect(service.eventCalls.first?.guestToken == "gt")
        #expect(service.joinCalls.first?.nickname == "Lea" && service.joinCalls.first?.credentials.guestToken == "gt")
    }

    @Test func joinsWithTheFaceTheGuestWasShown() async {
        let (model, service, _) = makeModel()
        service.eventResults = [.success(publicEvent)]
        service.joinResults = [.success(JoinResult(participant: guest, guestToken: "gt_new"))]
        await model.start()
        await model.join(nickname: "Lea", avatarSeed: "k3x9q2ab")
        #expect(service.joinAvatarSeeds == ["k3x9q2ab"])
    }

    @Test func busyNetworkAsksToTryTheNameAgainLater() async throws {
        let (model, service, store) = makeModel()
        service.eventResults = [.success(publicEvent)]
        service.joinResults = [
            .failure(MomentsAPIError.rateLimited),
            .success(JoinResult(participant: guest, guestToken: "gt_new")),
        ]
        await model.start()
        await model.join(nickname: "Lea")
        #expect(model.phase == .needsNickname(publicEvent, .busy))
        #expect(try store.credentials(for: slug)?.guestToken == nil)
        await model.join(nickname: "Lea")
        #expect(model.phase == .joined(publicEvent, guest))
    }

    @Test func returningGuestKeepsTheirIdentityWhenTheNetworkIsBusy() async throws {
        let saved = StoredEventCredentials(eventID: "e1", guestToken: "gt", participantID: "p1", nickname: "Lea")
        let store = InMemoryEventCredentialStore([slug: saved])
        let (model, service, _) = makeModel(store: store)
        service.eventResults = [.success(publicEvent), .success(publicEvent)]
        service.joinResults = [.failure(MomentsAPIError.rateLimited), .success(JoinResult(participant: guest, guestToken: nil))]
        await model.start()
        #expect(model.phase == .failed(.temporary))
        #expect(try store.credentials(for: slug) == saved)
        await model.retry()
        #expect(model.phase == .joined(publicEvent, guest))
    }

    @Test func returningGuestWithARevokedTokenChoosesANameAgain() async throws {
        let store = InMemoryEventCredentialStore([slug: StoredEventCredentials(eventID: "e1", guestToken: "gt", participantID: "p1", nickname: "Lea")])
        let (model, service, _) = makeModel(store: store)
        service.eventResults = [.success(publicEvent)]
        service.joinResults = [.failure(MomentsAPIError.nicknameTaken)]
        await model.start()
        #expect(model.phase == .needsNickname(publicEvent, nil))
        // Only the event ID was left, which counts as empty: the entry is gone.
        #expect(store.credentials(for: slug) == nil)
    }

    @Test func returningGuestTheServerForgotChoosesANameAgain() async throws {
        let store = InMemoryEventCredentialStore([slug: StoredEventCredentials(eventID: "e1", guestToken: "gt", participantID: "p1", nickname: "Lea")])
        let (model, service, _) = makeModel(store: store)
        service.eventResults = [.success(publicEvent)]
        service.joinResults = [.failure(MomentsAPIError.guestRequired)]
        await model.start()
        #expect(model.phase == .needsNickname(publicEvent, nil))
        #expect(store.credentials(for: slug)?.guestToken == nil)
    }

    @Test func tokenlessJoinOfSomeoneElsesNameCountsAsTaken() async throws {
        // Before enforcement the server lets a losing request in without a token.
        let (model, service, store) = makeModel()
        service.eventResults = [.success(publicEvent)]
        service.joinResults = [.success(JoinResult(participant: guest, guestToken: nil))]
        await model.start()
        await model.join(nickname: "Lea")
        #expect(model.phase == .needsNickname(publicEvent, .taken))
        #expect(try store.credentials(for: slug) == nil)
    }

    @Test func nicknameLimitCountsUTF16LikeTheServer() async {
        let (model, service, _) = makeModel()
        service.eventResults = [.success(publicEvent)]
        await model.start()
        await model.join(nickname: String(repeating: "🎉", count: 31))
        #expect(model.phase == .needsNickname(publicEvent, .invalid))
        #expect(service.joinCalls.isEmpty)
        #expect(JoinModel.isValidNickname(String(repeating: "🎉", count: 30)))
    }

    @Test func serverRejectedNicknameIsInvalid() async {
        let (model, service, _) = makeModel()
        service.eventResults = [.success(publicEvent)]
        service.joinResults = [.failure(MomentsAPIError.invalidRequest)]
        await model.start()
        await model.join(nickname: "Lea")
        #expect(model.phase == .needsNickname(publicEvent, .invalid))
    }

    @Test func inviteSurvivesANetworkErrorAndIsUsedOnRetry() async {
        let (model, service, _) = makeModel(invite: invite)
        service.accessResults = [.failure(MomentsAPIError.transport(.notConnectedToInternet)), .success(AccessGrant(token: "grant", expiresAt: future))]
        service.eventResults = [.success(privateEvent)]
        await model.start()
        #expect(model.phase == .failed(.temporary))
        await model.retry()
        #expect(service.accessCalls == [.invite(invite.value), .invite(invite.value)])
        #expect(model.phase == .needsNickname(privateEvent, nil))
    }

    @Test func inviteLockoutIsReported() async {
        let (model, service, _) = makeModel(invite: invite)
        service.accessResults = [.failure(MomentsAPIError.tooManyAttempts(retryAfterSeconds: 60))]
        await model.start()
        #expect(model.phase == .needsAccess(.tooManyAttempts(retryAfterSeconds: 60)))
    }

    @Test func startIsNotReentrant() async {
        let (model, service, _) = makeModel(invite: invite)
        service.accessResults = [.success(AccessGrant(token: "grant", expiresAt: future))]
        service.eventResults = [.success(privateEvent)]
        async let first: Void = model.start()
        async let second: Void = model.start()
        _ = await (first, second)
        await model.start()
        #expect(service.accessCalls.count == 1 && service.eventCalls.count == 1)
        #expect(model.phase == .needsNickname(privateEvent, nil))
    }

    @Test func lapsedGrantDuringJoinAsksForThePINAgain() async throws {
        let store = InMemoryEventCredentialStore([slug: StoredEventCredentials(eventID: "e1", accessGrant: "old", accessGrantExpiresAt: future)])
        let (model, service, _) = makeModel(store: store)
        service.eventResults = [.success(privateEvent), .success(privateEvent)]
        service.joinResults = [.failure(MomentsAPIError.accessRequired), .success(JoinResult(participant: guest, guestToken: "gt"))]
        service.accessResults = [.success(AccessGrant(token: "new", expiresAt: future))]
        await model.start()
        await model.join(nickname: "Lea")
        #expect(model.phase == .needsAccess(.expired))
        #expect(try store.credentials(for: slug)?.accessGrant == nil)
        await model.submitPIN("123456")
        await model.join(nickname: "Lea")
        #expect(model.phase == .joined(privateEvent, guest))
        #expect(service.joinCalls.last?.credentials.accessGrant == "new")
    }

    @Test func aFailedSaveKeepsTheTokenToSaveLater() async throws {
        let store = FlakyStore()
        let service = FakeService()
        let model = JoinModel(slug: slug, invite: nil, service: service, store: store)
        service.eventResults = [.success(publicEvent)]
        service.joinResults = [.success(JoinResult(participant: guest, guestToken: "gt_once"))]
        await model.start()
        store.failWrites = true
        await model.join(nickname: "Lea")
        #expect(model.phase == .joined(publicEvent, guest))
        #expect(model.hasUnsavedIdentity)
        store.failWrites = false
        model.retrySaving()
        #expect(!model.hasUnsavedIdentity)
        #expect(try store.credentials(for: slug)?.guestToken == "gt_once")
    }

    @Test func aSecondFailedSaveKeepsTryingAndStepsAreCounted() async throws {
        let store = FlakyStore()
        let service = FakeService()
        let model = JoinModel(slug: slug, invite: nil, service: service, store: store)
        service.eventResults = [.success(publicEvent)]
        service.joinResults = [.success(JoinResult(participant: guest, guestToken: "gt_once"))]
        await model.start()
        store.failWrites = true
        await model.join(nickname: "Lea")
        model.retrySaving()
        #expect(model.hasUnsavedIdentity)
        #expect(model.stepCount == 2)
        store.failWrites = false
        model.retrySaving()
        #expect(try store.credentials(for: slug)?.guestToken == "gt_once")
    }

    @Test func storeFailuresAreReportedAsStorageAndRetryable() async {
        let store = FlakyStore()
        store.failReads = true
        let service = FakeService()
        let model = JoinModel(slug: slug, invite: nil, service: service, store: store)
        service.eventResults = [.success(publicEvent)]
        await model.start()
        #expect(model.phase == .failed(.storage))
        #expect(service.eventCalls.isEmpty)
        store.failReads = false
        await model.retry()
        #expect(model.phase == .needsNickname(publicEvent, nil))
    }

    @Test func repeatedWrongPINsStillCountAsNewSteps() async {
        let (model, service, _) = makeModel()
        service.eventResults = [.failure(MomentsAPIError.accessRequired)]
        service.accessResults = [.failure(MomentsAPIError.invalidAccess), .failure(MomentsAPIError.invalidAccess)]
        await model.start()
        await model.submitPIN("111111")
        let afterFirst = model.stepCount
        await model.submitPIN("222222")
        #expect(model.phase == .needsAccess(.wrongPIN))
        #expect(model.stepCount == afterFirst + 1)
    }

    @Test func aGrantRejectedRightAfterUnlockSaysAccessExpired() async {
        let (model, service, _) = makeModel()
        service.eventResults = [.failure(MomentsAPIError.accessRequired), .failure(MomentsAPIError.accessRequired)]
        service.accessResults = [.success(AccessGrant(token: "grant", expiresAt: future))]
        await model.start()
        #expect(model.phase == .needsAccess(nil))
        await model.submitPIN("123456")
        #expect(model.phase == .needsAccess(.expired))
    }

    @Test func returningGuestKeepsTheirIdentityWhenOffline() async throws {
        let store = InMemoryEventCredentialStore([slug: StoredEventCredentials(eventID: "e1", guestToken: "gt", participantID: "p1", nickname: "Lea")])
        let (model, service, _) = makeModel(store: store)
        service.eventResults = [.success(publicEvent)]
        service.joinResults = [.failure(MomentsAPIError.transport(.notConnectedToInternet))]
        await model.start()
        #expect(model.phase == .failed(.temporary))
        #expect(try store.credentials(for: slug)?.guestToken == "gt")
    }

    @Test func joinSendsTheExistingGuestTokenAndKeepsIt() async throws {
        let store = InMemoryEventCredentialStore([slug: StoredEventCredentials(eventID: "e1", guestToken: "gt", participantID: "p1")])
        let (model, service, _) = makeModel(store: store)
        service.eventResults = [.success(publicEvent)]
        service.joinResults = [.success(JoinResult(participant: guest, guestToken: nil))]
        await model.start()
        await model.join(nickname: "Lea")
        #expect(service.joinCalls.first?.credentials.guestToken == "gt")
        #expect(try store.credentials(for: slug)?.guestToken == "gt")
    }

    @Test(arguments: [
        (MomentsAPIError.eventNotFound, JoinModel.Failure.eventNotFound),
        (.upgradeRequired, .upgradeRequired),
        (.accessUnavailable, .accessUnavailable),
        (.transport(.notConnectedToInternet), .temporary),
        (.server(status: 500, code: nil), .temporary),
        (.unexpectedResponse, .temporary),
    ])
    func failuresAreTyped(_ error: MomentsAPIError, _ expected: JoinModel.Failure) async {
        let (model, service, _) = makeModel()
        service.eventResults = [.failure(error), .success(publicEvent)]
        await model.start()
        #expect(model.phase == .failed(expected))
        // Only temporary failures can be retried; the others are final.
        await model.retry()
        #expect(model.phase == (expected == .temporary ? .needsNickname(publicEvent, nil) : .failed(expected)))
    }

    @Test func avatarSeedsLookLikeTheWebs() {
        let seed = JoinModel.randomAvatarSeed()
        #expect(seed.wholeMatch(of: /[a-z0-9]{8}/) != nil)
    }
}
