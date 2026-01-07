import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { randomId } from "../../shared/randomId"
import { tupleDb } from "../../tupleDb/TupleDb"
import { TupleDb } from "../../tupleDb/types"
import { syncServer } from "../SyncServer"
import { SimpleSyncClient } from "./SimpleSyncClient"
import { ChatId, ChatReducers, Message, UserReducers } from "./types"

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

const allReducers = {
	...userReducers,
	...chatReducers,
}

describe("SyncExample2: Normalized / Multi-Subspace Architecture with SimpleSyncClient", () => {
	it("should demonstrate waterfall loading and partial replication", async () => {
		// 1. Setup Server
		const masterDb = tupleDb()
		const serverApi = syncServer(masterDb, allReducers as any)

		// 2. Setup Client
		const alice = new SimpleSyncClient(serverApi, allReducers)

		// 3. Setup Server Data
		const chat1 = { id: "chat1", name: "General", memberIds: ["alice"] }
		await serverApi.write(["user", "alice"], [
			{
				id: randomId(),
				clock: 0,
				commitedAt: new Date().toISOString(),
				createdAt: new Date().toISOString(),
				ops: [{ fn: "addChat", args: [chat1] }],
			},
		])

		// 4. Client Lifecycle: Waterfall

		// Step A: Load User Data
		const userDb = alice.sync(["user", "alice"])
		let knownChats: any[] = []

		const userUnsub = userDb.query({ prefix: ["chats"] }, (res) => {
			if (!res.loading) {
				knownChats = res.data.map((i) => i.value)
			}
		})

		// Wait for fetch
		// In tests we manually trigger/await refresh because query() triggers it async-ish (fire and forget).
		// Actually, query() triggers it synchronously in my implementation but it's async promise.
		// We need to await the network trip.
		await userDb.refresh({ prefix: ["chats"] })

		assert.equal(knownChats.length, 1)
		assert.equal(knownChats[0].id, "chat1")

		// Step B: Dependent Query - Load Messages for known chats
		const chatId = knownChats[0].id
		const chatDb = alice.sync(["chat", chatId])
		let messages: Message[] = []

		const chatUnsub = chatDb.query({ prefix: ["messages"] }, (res) => {
			if (!res.loading) {
				messages = res.data.map((i) => i.value)
			}
		})

		// Initial empty
		assert.equal(messages.length, 0)

		// 5. Interaction: Alice posts a message (Optimistic)
		const msg: Message = {
			id: randomId(),
			chatId,
			fromId: "alice",
			body: "Optimistic Hello!",
			createdAt: new Date().toISOString(),
		}

		await chatDb.write([{ fn: "postMessage", args: [msg] }])

		// Verify Optimistic Update (Immediate)
		// The cache listener should have fired synchronously after write?
		// TupleCache.write calls listeners.
		assert.equal(messages.length, 1)
		assert.equal(messages[0].body, "Optimistic Hello!")

		// 6. Verify Server Persistence (Bob)
		const bob = new SimpleSyncClient(serverApi, allReducers)
		const bobChatDb = bob.sync(["chat", chatId])
		let bobMessages: Message[] = []

		bobChatDb.query({ prefix: ["messages"] }, (res) => {
			if (!res.loading) {
				bobMessages = res.data.map((i) => i.value)
			}
		})

		await bobChatDb.refresh({ prefix: ["messages"] })

		assert.equal(bobMessages.length, 1)
		assert.equal(bobMessages[0].body, "Optimistic Hello!")

		userUnsub()
		chatUnsub()
	})
})
