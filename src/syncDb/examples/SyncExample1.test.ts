import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { randomId } from "../../shared/randomId"
import { tupleDb } from "../../tupleDb/TupleDb"
import { TupleDb } from "../../tupleDb/types"
import { syncDb } from "../SyncDb"
import { syncServer } from "../SyncServer"
import { Commit, SyncApi } from "../types"
import { ChatId, FanOutReducers, Message, User, UserId, UserProfile } from "./types"

// ============================================================================
// Helpers
// ============================================================================

// A simple in-memory SyncClient for Example 1
// We rebuild a mini-client here to specifically match the single-subspace pattern
// without the full complexity of the generic SyncClient if strictly needed,
// but let's try to use the patterns from SyncDb.ts/SyncServer.ts.

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

describe("SyncExample1: Fan-out Architecture", () => {
	it("should fan out messages to recipient subspaces", async () => {
		// 1. Setup Server
		// The server holds the "Master" DB.
		const masterDb = tupleDb()
		const serverApi = syncServer(masterDb, createFanOutReducers())

		// We need a way to intercept "Intent" (High-level Ops) and fan them out.
		// In this architecture, the client writes "Intent" to its own queue,
		// or calls a server API.
		// Let's model it as: Client writes to its own Outbox, Server processes Outbox.
		// OR: Client calls a special "RPC" via a sync write?
		// For this example, let's assume the Server provides a specific API `sendMessage`
		// that internally writes to SyncDbs.

		const chatMembers = new Map<ChatId, UserId[]>()
		chatMembers.set("chat1", ["alice", "bob"])

		// Server Logic: Fan-out
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

			// Fan out to each member's subspace
			// We can batch these writes if SyncServer supports it,
			// or just write sequentially.
			for (const memberId of members) {
				const scope = ["user", memberId]

				// We construct a Commit for this user
				const commit: Commit = {
					id: randomId(),
					clock: 0, // Server will assign
					commitedAt: new Date().toISOString(),
					createdAt: new Date().toISOString(),
					ops: [
						{
							fn: "putMessage",
							args: [message],
						},
					],
				}

				await serverApi.write(scope, [commit])
			}
		}

		// 2. Setup Clients (Alice and Bob)
		// They only subscribe to their own subspace: ["user", id]

		async function createClient(userId: string) {
			const scope = ["user", userId]
			let lastClock = 0
			// Initial fetch
			const res = await serverApi.read(scope, {}, lastClock)
			lastClock = res.clock

			// Client State
			const db = tupleDb()
			const reducers = createFanOutReducers()
			const localSyncDb = syncDb(db, reducers)

			// Apply initial data
			// (In a real app, we'd hydrate from res.data and apply history updates)
			for (const { value } of res.updates) {
				localSyncDb.write(value as Commit) // This applies to local state
			}

			// Polling function to simulate subscription
			async function poll() {
				const updates = await serverApi.fetch(scope, lastClock)
				if (updates.updates.length > 0) {
					lastClock = updates.clock
					for (const commit of updates.updates) {
						localSyncDb.write(commit)
					}
				}
			}

			return {
				userId,
				db: localSyncDb,
				poll,
			}
		}

		const alice = await createClient("alice")
		const bob = await createClient("bob")

		// 3. Action: Alice sends a message
		await serverHandleSendMessage("alice", "chat1", "Hello Bob!")

		// 4. Sync: Clients receive updates
		await alice.poll()
		await bob.poll()

		// 5. Verify
		// Alice should see the message in her DB
		const aliceMsgs = alice.db.data.list({ prefix: ["messages"] })
		assert.equal(aliceMsgs.length, 1)
		assert.equal((aliceMsgs[0].value as Message).body, "Hello Bob!")

		// Bob should see the message in his DB
		const bobMsgs = bob.db.data.list({ prefix: ["messages"] })
		assert.equal(bobMsgs.length, 1)
		assert.equal((bobMsgs[0].value as Message).body, "Hello Bob!")

		// 6. Action: Bob replies
		await serverHandleSendMessage("bob", "chat1", "Hi Alice!")

		await alice.poll()
		await bob.poll()

		const aliceMsgs2 = alice.db.data.list({ prefix: ["messages"] })
		assert.equal(aliceMsgs2.length, 2)
		assert.equal((aliceMsgs2[1].value as Message).body, "Hi Alice!")
	})
})
