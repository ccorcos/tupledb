import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { randomId } from "../../shared/randomId"
import { tupleDb } from "../../tupleDb/TupleDb"
import { TupleDb } from "../../tupleDb/types"
import { syncDb } from "../SyncDb"
import { syncServer } from "../SyncServer"
import { Commit } from "../types"
import { ChatId, ChatReducers, Message, UserId, UserReducers } from "./types"

// ============================================================================
// Reducers
// ============================================================================

const userReducers: UserReducers = {
	addChat: (tx: TupleDb, chat: any) => {
		tx.set(["chats", chat.id], chat)
	},
	removeChat: (tx: TupleDb, chatId: ChatId) => {
		tx.delete(["chats", chatId])
	},
}

const chatReducers: ChatReducers = {
	postMessage: (tx: TupleDb, msg: Message) => {
		tx.set(["messages", msg.createdAt, msg.id], msg)
	},
}

// Composite Reducers Map for the server to route
const allReducers = {
	...userReducers,
	...chatReducers,
}

describe("SyncExample2: Normalized / Multi-Subspace Architecture", () => {
	it("should allow clients to subscribe to multiple shared subspaces", async () => {
		// 1. Setup Server
		const masterDb = tupleDb()
		const serverApi = syncServer(masterDb, allReducers as any)

		// 2. Client Implementation
		// A client that manages multiple SyncDbs internally
		class MultiDbClient {
			dbs = new Map<string, ReturnType<typeof syncDb>>()

			constructor(public userId: string) {}

			// Get or create a local sync connection to a subspace
			getDb(scope: string[], reducers: any) {
				const key = JSON.stringify(scope)
				if (!this.dbs.has(key)) {
					// In a real app, this would use a proper storage layer
					const db = tupleDb()
					this.dbs.set(key, syncDb(db, reducers))
				}
				return this.dbs.get(key)!
			}

			// Simulate syncing a specific scope
			async syncScope(scope: string[], lastClock: number) {
				const res = await serverApi.fetch(scope, lastClock)
				const db = this.getDb(scope, allReducers) // Using allReducers for simplicity
				for (const commit of res.updates) {
					db.write(commit)
				}
				return res.clock
			}
		}

		const alice = new MultiDbClient("alice")
		const bob = new MultiDbClient("bob")

		// 3. Setup Initial State (Server Side)
		// Create a chatroom and add it to Alice and Bob's UserDB
		const chat1 = { id: "chat1", name: "General", memberIds: ["alice", "bob"] }

		// Write to Alice's UserDB
		await serverApi.write(["user", "alice"], [
			{
				id: randomId(),
				clock: 0,
				commitedAt: new Date().toISOString(),
				createdAt: new Date().toISOString(),
				ops: [{ fn: "addChat", args: [chat1] }],
			},
		])

		// Write to Bob's UserDB
		await serverApi.write(["user", "bob"], [
			{
				id: randomId(),
				clock: 0,
				commitedAt: new Date().toISOString(),
				createdAt: new Date().toISOString(),
				ops: [{ fn: "addChat", args: [chat1] }],
			},
		])

		// 4. Alice Syncs her UserDB
		let aliceUserClock = 0
		aliceUserClock = await alice.syncScope(["user", "alice"], aliceUserClock)

		// Alice sees the chat
		const aliceUserDb = alice.getDb(["user", "alice"], userReducers)
		const chats = aliceUserDb.data.list({ prefix: ["chats"] })
		assert.equal(chats.length, 1)
		assert.equal(chats[0].value.id, "chat1")

		// 5. Alice posts a message to "chat1"
		// This write goes to the SHARED ["chat", "chat1"] subspace
		const msg: Message = {
			id: randomId(),
			chatId: "chat1",
			fromId: "alice",
			body: "Hello Shared World!",
			createdAt: new Date().toISOString(),
		}

		// Alice creates a commit for the chat subspace
		const chatCommit: Commit = {
			id: randomId(),
			clock: 0,
			commitedAt: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			ops: [{ fn: "postMessage", args: [msg] }],
		}

		// Alice sends it to the server targeting ["chat", "chat1"]
		await serverApi.write(["chat", "chat1"], [chatCommit])

		// 6. Bob discovers and syncs "chat1"
		// Bob first syncs his user DB to find chats
		let bobUserClock = 0
		bobUserClock = await bob.syncScope(["user", "bob"], bobUserClock)
		const bobChats = bob.getDb(["user", "bob"], userReducers).data.list({ prefix: ["chats"] })
		assert.equal(bobChats.length, 1)
		const chatId = bobChats[0].value.id

		// Bob now syncs the chat DB
		let bobChatClock = 0
		bobChatClock = await bob.syncScope(["chat", chatId], bobChatClock)

		// Bob checks messages
		const bobChatDb = bob.getDb(["chat", chatId], chatReducers)
		const msgs = bobChatDb.data.list({ prefix: ["messages"] })
		assert.equal(msgs.length, 1)
		assert.equal((msgs[0].value as Message).body, "Hello Shared World!")
	})
})
