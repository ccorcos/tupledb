import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { randomId } from "../../shared/randomId"
import { tupleDb } from "../../tupleDb/TupleDb"
import { TupleDb } from "../../tupleDb/types"
import { syncServer } from "../SyncServer"
import { Commit } from "../types"
import { SimpleSyncClient } from "./SimpleSyncClient"
import { ChatId, FanOutReducers, Message, User, UserId, UserProfile } from "./types"

// ============================================================================
// Helpers
// ============================================================================

function createFanOutReducers(): FanOutReducers {
	return {
		putUser: (tx: TupleDb, user: User) => {
			tx.set(["users", user.id], user)
		},
		putMessage: (tx: TupleDb, msg: Message) => {
			tx.set(["messages", msg.chatId, msg.createdAt, msg.id], msg)
		},
		putProfile: (tx: TupleDb, profile: UserProfile) => {
			tx.set(["profiles", profile.id], profile)
		},
	}
}

describe("SyncExample1: Fan-out Architecture with SimpleSyncClient", () => {
	it("should fan out messages and update client via cache subscription", async () => {
		// 1. Setup Server
		const masterDb = tupleDb()
		const serverApi = syncServer(masterDb, createFanOutReducers())

		const chatMembers = new Map<ChatId, UserId[]>()
		chatMembers.set("chat1", ["alice", "bob"])

		async function serverHandleSendMessage(
			fromId: UserId,
			chatId: ChatId,
			body: string
		): Promise<void> {
			const members = chatMembers.get(chatId) || []
			const message: Message = {
				id: randomId(),
				chatId,
				fromId,
				body,
				createdAt: new Date().toISOString(),
			}

			// Fan out
			for (const memberId of members) {
				const scope = ["user", memberId]
				const commit: Commit = {
					id: randomId(),
					clock: 0,
					commitedAt: new Date().toISOString(),
					createdAt: new Date().toISOString(),
					ops: [{ fn: "putMessage", args: [message] }],
				}
				await serverApi.write(scope, [commit])
			}
		}

		// 2. Setup Clients
		const createClient = (userId: string) =>
			new SimpleSyncClient(serverApi, createFanOutReducers())

		const alice = createClient("alice")
		const bob = createClient("bob")

		// 3. Alice Subscribes to her messages
		const aliceMessages: Message[] = []
		const aliceUnsub = alice
			.sync(["user", "alice"])
			.query({ prefix: ["messages"] }, (result) => {
				if (!result.loading) {
					aliceMessages.length = 0
					aliceMessages.push(...result.data.map((i) => i.value))
				}
			})

		// 4. Bob Subscribes to his messages
		const bobMessages: Message[] = []
		const bobUnsub = bob.sync(["user", "bob"]).query({ prefix: ["messages"] }, (result) => {
			if (!result.loading) {
				bobMessages.length = 0
				bobMessages.push(...result.data.map((i) => i.value))
			}
		})

		// Initial state
		assert.equal(aliceMessages.length, 0)

		// 5. Action: Alice sends a message
		await serverHandleSendMessage("alice", "chat1", "Hello Bob!")

		// 6. Refresh Clients (Simulate polling)
		// We need to expose refresh from the handle?
		// For the test, we can just re-trigger the query internal fetch?
		// Or simpler: The `query` method in SimpleSyncClient triggers `refresh`.
		// But here we want to trigger it manually again.
		// Let's add a public refresh to the client for testing or just re-subscribe?
		// Re-subscribing is messy.
		// Let's modify SimpleSyncClient to expose a way to refresh a scope.
		// Or... we just use the `refresh` method on the scoped sync if we kept a reference.
		// The `query` returned an unsubscribe.
		// Let's instantiate the ScopedSync first.

		const aliceScope = alice.sync(["user", "alice"])
		const bobScope = bob.sync(["user", "bob"])

		// We need to re-run the query subscription logic to hook up the 'refresh' but `query` handles it.
		// But for TEST we want to force a refresh now.
		await aliceScope.refresh({ prefix: ["messages"] })
		await bobScope.refresh({ prefix: ["messages"] })

		// 7. Verify
		assert.equal(aliceMessages.length, 1)
		assert.equal(aliceMessages[0].body, "Hello Bob!")

		assert.equal(bobMessages.length, 1)
		assert.equal(bobMessages[0].body, "Hello Bob!")

		// 8. Action: Bob replies
		await serverHandleSendMessage("bob", "chat1", "Hi Alice!")

		await aliceScope.refresh({ prefix: ["messages"] })
		await bobScope.refresh({ prefix: ["messages"] })

		assert.equal(aliceMessages.length, 2)
		assert.equal(aliceMessages[1].body, "Hi Alice!")

		aliceUnsub()
		bobUnsub()
	})
})
