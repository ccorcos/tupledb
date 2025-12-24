import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { tupleDb } from "../TupleDb"
import { SyncManager } from "./SyncClient"
import { SyncServer } from "./SyncServer"
import { SyncPushResponse } from "./types"
import { syncDb } from "../SyncDb"

// Mock transport
const createTransport = (server: SyncServer) => {
	let online = true
	return {
		setOnline: (status: boolean) => (online = status),
		push: async (prefix: any[], req: any): Promise<SyncPushResponse> => {
			if (!online) throw new Error("Offline")
			await new Promise((resolve) => setTimeout(resolve, 10))
			return server.push(prefix, req)
		},
	}
}

describe("SyncDb", () => {
	it("syncs between client and server", async () => {
		const serverDb = tupleDb()
		const reducers = {
			sendMessage: (tx: any, msg: any) => {
				// Reducer must use SyncDb to ensure writes are tracked
				// We assume 'tx' is the context-aware transaction
				const db = syncDb(tx.subspace(["user", msg.fromId]))
				db.set(["inbox", msg.id], msg)
			},
		}

		const server = new SyncServer(serverDb, reducers)
		const transport = createTransport(server)

		const clientDb = tupleDb()
		const manager = new SyncManager({
			db: clientDb,
			reducers,
			transport: transport.push,
		})

		const session = manager.session(["user", 1])

		// 1. Dispatch Optimistic Op
		const msg1 = { id: "msg1", fromId: 1, text: "hello" }
		session.dispatch("sendMessage", msg1)

		// Verify optimistic update in Global Cache
		// Data should be at ["user", 1, "data", "inbox", "msg1"]
		const key = ["user", 1, "data", "inbox", "msg1"]
		const cacheRes = manager.cache.list({ gte: key, lte: key })
		const val = cacheRes.hit?.[0]?.value

		assert.ok(val, "Value should be present in cache")
		assert.deepEqual(val, msg1, "Value should match msg1")

		// Verify NOT yet in Client DB (pending)
		assert.equal(clientDb.get(key), undefined)

		// Wait for sync
		await new Promise((resolve) => setTimeout(resolve, 50))

		// Verify applied to Server (at subspace)
		// Server DB should have: `["user", 1, "data", "inbox", "msg1"]`
		const serverKey = ["user", 1, "data", "inbox", "msg1"]
		const serverHit = serverDb
			.list()
			.find((item) => JSON.stringify(item.key) === JSON.stringify(serverKey))
		assert.ok(serverHit, "Item should be in server DB")
		assert.deepEqual(serverHit.value, msg1)

		// Client DB check
		// Client DB should have data now
		const clientHit = clientDb
			.list()
			.find((item) => JSON.stringify(item.key) === JSON.stringify(key))
		assert.ok(clientHit, "Item should be in client DB at data path")
		assert.deepEqual(clientHit.value, msg1)

		// 2. Sync from another client
		// Another client pushes to server for the same user.
		const msg2 = { id: "msg2", fromId: 1, text: "world" }
		
		// Simulate another client pushing
		// We can just call server.push directly
		server.push(["user", 1], {
			ops: [{ id: "op2", fn: "sendMessage", args: [msg2], timestamp: Date.now() }],
			syncedClock: 0,
		})

		// Client syncs again (triggered by new dispatch or manually)
		// We trigger a manual sync or dispatch something to force sync
		session.dispatch("sendMessage", { id: "trigger", fromId: 1, text: "force sync" })
		await new Promise((resolve) => setTimeout(resolve, 50))

		// Client should receive msg2
		const key2 = ["user", 1, "data", "inbox", "msg2"]
		const clientHit2 = clientDb
			.list()
			.find((item) => JSON.stringify(item.key) === JSON.stringify(key2))
		assert.ok(clientHit2, "Client should receive msg2")
	})

	it("handles multiple sessions", async () => {
		const serverDb = tupleDb()
		const reducers = {
			write: (tx: any, k: any, v: any, userId: number) => {
				const db = syncDb(tx.subspace(["user", userId]))
				db.set(k, v)
			}
		}
		const server = new SyncServer(serverDb, reducers)
		const transport = createTransport(server)

		const manager = new SyncManager({
			db: tupleDb(),
			reducers,
			transport: transport.push,
		})

		const sess1 = manager.session(["user", 1])
		const sess2 = manager.session(["user", 2])

		sess1.dispatch("write", ["val"], 1, 1)
		sess2.dispatch("write", ["val"], 2, 2)

		await new Promise((r) => setTimeout(r, 50))

		// Check local separation
		const k1 = ["user", 1, "data", "val"]
		const k2 = ["user", 2, "data", "val"]

		const hit1 = manager.cache.list({ gte: k1, lte: k1 }).hit?.[0]
		const hit2 = manager.cache.list({ gte: k2, lte: k2 }).hit?.[0]

		assert.equal(hit1?.value, 1)
		assert.equal(hit2?.value, 2)
	})
})