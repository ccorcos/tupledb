import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { tupleDb } from "../TupleDb"
import { SyncManager } from "./SyncClient"
import { SyncServer } from "./SyncServer"
import { SyncPushResponse } from "./types"

// Mock transport
const createTransport = (server: SyncServer) => {
	let online = true
	return {
		setOnline: (status: boolean) => (online = status),
		push: async (prefix: any[], req: any): Promise<SyncPushResponse> => {
			if (!online) throw new Error("Offline")
			await new Promise((resolve) => setTimeout(resolve, 10))
			// The Server is usually monolithic or subspace-aware.
			// For this test, we assume the server serves the specific prefix.
			// We'll wrap the server logic to target the prefix manually if needed,
			// or we assume `server.push` writes to the root it was given.

			// In the new architecture, Client `SyncSession(["user", 1])` pushes to server.
			// If the server was initialized with `db.subspace(["user", 1])`, then direct push is fine.
			// But here we have one `server` instance.
			// Let's assume the server is "Multi-Tenant" capable or we just route to `server.push`.
			// But `SyncServer` writes to `["clock"]` at root.

			// To properly test "Sync Spaces", we should probably use `server.db.subspace(prefix)`?
			// But `SyncServer` class doesn't support dynamic subspace in `push`.
			// Let's re-instantiate a SyncServer for the prefix on the fly for the test.
			const scopedDb = server.db.subspace(prefix)
			const scopedServer = new SyncServer(scopedDb, server.reducers)
			return scopedServer.push(req)
		},
	}
}

describe("SyncDb", () => {
	it("syncs between client and server", async () => {
		const serverDb = tupleDb()
		const reducers = {
			sendMessage: (tx: any, msg: any) => {
				tx.set(["inbox", msg.id], msg)
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
		const msg1 = { id: "msg1", text: "hello" }
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
		// Server DB has `["user", 1, "data", "inbox", "msg1"]`?
		// Yes, because `createTransport` created a subspace `["user", 1]`.
		// The reducer writes `["inbox", ...]`.
		// So `subspace.set(["inbox", ...])` -> `root.set(["user", 1, "inbox", ...])`?
		// Wait, `SyncServer` logic: `reducer(tx)`. `tx` writes to root of that server.
		// If server is `db.subspace(["user", 1])`.
		// Reducer writes `["inbox", "msg1"]`.
		// Result in `serverDb` (root) is `["user", 1, "inbox", "msg1"]`.
		// But `SyncClient` expects data at `[...prefix, "data", ...]`.

		// Mismatch!
		// `SyncClient` wraps local writes in `["data"]`.
		// The `SyncServer` (and shared Reducers) usually define the schema.
		// If the Reducer writes `["inbox"]`, that's the canonical key.
		// `SyncClient` puts it in `["data"]` locally to avoid collision with `["clock"]`.
		// Does `SyncServer` put it in `["data"]`?
		// My `SyncServer.ts` implementation: `reducer(tx, ...op.args)`. No wrapping!
		// So Server stores `["user", 1, "inbox", ...]`.
		// Client stores `["user", 1, "data", "inbox", ...]`.

		// This discrepancy is fine IF the Client knows how to map it.
		// `SyncClient.applyServerOp`: `const dataPrefix = [...this.prefix, "data"]`.
		// It wraps writes from server in `dataPrefix`.
		// So Client *adds* the "data" layer locally.
		// The Server *does not* have the "data" layer in its schema (unless reducer puts it there).

		// So Server DB should have: `["user", 1, "inbox", "msg1"]`.
		// Client DB should have: `["user", 1, "data", "inbox", "msg1"]`.

		const serverKey = ["user", 1, "inbox", "msg1"]
		const serverHit = serverDb
			.list()
			.find((item) => JSON.stringify(item.key) === JSON.stringify(serverKey))
		assert.ok(serverHit, "Item should be in server DB")
		assert.deepEqual(serverHit.value, msg1)

		// Client DB check
		const clientHit = clientDb
			.list()
			.find((item) => JSON.stringify(item.key) === JSON.stringify(key))
		assert.ok(clientHit, "Item should be in client DB at data path")
		assert.deepEqual(clientHit.value, msg1)

		// 2. Sync from another client
		// Another client pushes to server for the same user.
		const msg2 = { id: "msg2", text: "world" }
		// We simulate server receiving it.
		// We need to use the `scopedServer` logic again to write to the right place.
		const scopedDb = serverDb.subspace(["user", 1])
		const scopedServer = new SyncServer(scopedDb, server.reducers)
		scopedServer.push({
			ops: [{ id: "op2", fn: "sendMessage", args: [msg2], timestamp: Date.now() }],
			syncedClock: 0,
		})

		// Client syncs again
		session.dispatch("sendMessage", { id: "trigger", text: "force sync" })
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
		const reducers = { write: (tx: any, k: any, v: any) => tx.set(k, v) }
		const server = new SyncServer(serverDb, reducers)
		const transport = createTransport(server)

		const manager = new SyncManager({
			db: tupleDb(),
			reducers,
			transport: transport.push,
		})

		const sess1 = manager.session(["user", 1])
		const sess2 = manager.session(["user", 2])

		sess1.dispatch("write", ["val"], 1)
		sess2.dispatch("write", ["val"], 2)

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
