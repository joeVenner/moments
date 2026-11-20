import CredentialStore
import Foundation
import MomentsAPI
import MomentsDomain
import Testing
@testable import FeatureGuest

private let day: TimeInterval = 86_400

private func event(_ slug: String, startsAt: Date?) -> Event {
    Event(id: "id-\(slug)", slug: slug, title: slug.capitalized, type: "party", createdAt: .distantPast, startsAt: startsAt)
}

private func joined(_ nickname: String = "Sam") -> StoredEventCredentials {
    StoredEventCredentials(guestToken: "gt_secret", nickname: nickname)
}

@Suite @MainActor struct MyEventsModelTests {
    @Test func listsJoinedEventsNewestFirstAndDropsGoneOnes() async {
        // Slugs are listed alphabetically: bday, gone, wedding.
        let store = InMemoryEventCredentialStore([
            EventSlug("wedding")!: joined(), EventSlug("bday")!: joined("Ana"), EventSlug("gone")!: joined(),
        ])
        let service = FakeService()
        service.eventResults = [
            .success(event("bday", startsAt: Date(timeIntervalSince1970: 1 * day))),
            .failure(MomentsAPIError.eventNotFound),
            .success(event("wedding", startsAt: Date(timeIntervalSince1970: 9 * day))),
        ]
        let model = MyEventsModel(service: service, store: store)
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.entries.map(\.id) == ["wedding", "bday"])
        #expect(model.entries.last?.nickname == "Ana")
        // Every request carried the stored guest token.
        #expect(service.eventCalls.allSatisfy { $0.guestToken == "gt_secret" })
    }

    @Test func entriesWithoutDetailsStayOpenableAndSortLast() async {
        let store = InMemoryEventCredentialStore([
            EventSlug("alpha")!: joined(), EventSlug("beta")!: joined(), EventSlug("gamma")!: joined(),
        ])
        let service = FakeService()
        service.eventResults = [
            .failure(MomentsAPIError.accessRequired),
            .failure(URLError(.notConnectedToInternet)),
            .success(event("gamma", startsAt: nil)),
        ]
        let model = MyEventsModel(service: service, store: store)
        await model.load()
        #expect(model.entries.map(\.id) == ["gamma", "alpha", "beta"])
        #expect(model.entries[1].details == .locked)
        #expect(model.entries[2].details == .unavailable)
    }

    @Test func anEventNoLongerHostedStaysListedAndSaysSo() async {
        let store = InMemoryEventCredentialStore([EventSlug("party")!: joined()])
        let service = FakeService()
        service.eventResults = [.failure(MomentsAPIError.eventNotHosted)]
        let model = MyEventsModel(service: service, store: store)
        await model.load()
        #expect(model.entries.map(\.id) == ["party"] && model.entries.first?.details == .notHosted)
    }

    @Test func storedGrantsWithoutAGuestTokenAreNotJoinedEvents() async {
        let grantOnly = StoredEventCredentials(accessGrant: "grant", accessGrantExpiresAt: .distantFuture)
        let store = InMemoryEventCredentialStore([EventSlug("party")!: grantOnly])
        let service = FakeService()
        let model = MyEventsModel(service: service, store: store)
        await model.load()
        #expect(model.entries.isEmpty && model.phase == .loaded)
        #expect(service.eventCalls.isEmpty)
    }

    @Test func anExpiredGrantIsNotSent() async {
        let stored = StoredEventCredentials(accessGrant: "old", accessGrantExpiresAt: .distantPast, guestToken: "gt_secret")
        let service = FakeService()
        service.eventResults = [.failure(MomentsAPIError.accessRequired)]
        let model = MyEventsModel(service: service, store: InMemoryEventCredentialStore([EventSlug("party")!: stored]))
        await model.load()
        #expect(service.eventCalls.first?.accessGrant == nil)
        #expect(model.entries.first?.details == .locked)
    }

    @Test func anUnreadableStoreReportsUnavailable() async {
        let store = FlakyStore()
        store.failReads = true
        let model = MyEventsModel(service: FakeService(), store: store)
        await model.load()
        #expect(model.phase == .unavailable && model.entries.isEmpty)
    }

    @Test func aReusedSlugDropsTheOldEventsEntry() async throws {
        var stale = joined("Bob")
        stale.eventID = "deleted-event"
        let store = InMemoryEventCredentialStore([EventSlug("party")!: stale])
        let service = FakeService()
        service.eventResults = [.success(event("party", startsAt: nil))]
        let model = MyEventsModel(service: service, store: store)
        await model.load()
        #expect(model.entries.isEmpty)
        #expect(store.credentials(for: EventSlug("party")!) == nil)
    }

    @Test func anEntryRecordsTheEventItWasShownFor() async {
        let store = InMemoryEventCredentialStore([EventSlug("party")!: joined()])
        let service = FakeService()
        service.eventResults = [.success(event("party", startsAt: nil))]
        await MyEventsModel(service: service, store: store).load()
        #expect(store.credentials(for: EventSlug("party")!)?.eventID == "id-party")
    }

    @Test func aCancelledLoadPublishesNothing() async {
        let store = InMemoryEventCredentialStore([EventSlug("party")!: joined()])
        let service = FakeService()
        service.eventResults = [.failure(URLError(.cancelled))]
        let model = MyEventsModel(service: service, store: store)
        let task = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            await model.load()
        }
        await task.value
        #expect(model.entries.isEmpty && model.phase == .idle)
    }
}
