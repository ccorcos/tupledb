import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { tupleDb } from "../tupleDb/TupleDb"
import { ListArgs, Tuple } from "../tupleDb/types"
import { SyncCache } from "./SyncClient"
import { syncDb } from "./SyncDb"
import { syncServer } from "./SyncServer"
import { Commit, ReadResult, SyncResult, WriteResult, Pubsub, JSONValue, SyncApi } from "./types"

// Mock Pubsub
const createPubsub = (): Pubsub => {
	const listeners = new Set<{ tuple: Tuple, listener: (t: Tuple, v: JSONValue) => void }>()
	return {
		publish: (tuple, value) => {
			for (const { listener } of listeners) {
				listener(tuple, value)
			}
		},
		subscribe: (tuple) => {},
		onMessage: (listener) => {
			const item = { tuple: [], listener }
			listeners.add(item)
			return () => {
                listeners.delete(item)
            }
		}
	}
}

// Mock API (formerly transport)
const createApi = (server: any): SyncApi & { setOnline: (status: boolean) => void } => {
	let online = true
	return {
		// setOnline is not on SyncApi, but we keep it on the object returned by createApi for testing control.
		// However, TypeScript might complain if we assign this object to SyncApi type variable and it has extra methods?
		// No, extra methods are fine.
		// BUT we need to cast or define an intersection type if we want to use setOnline later.
		
		setOnline: (status: boolean) => (online = status),

		write: async (prefix: any[], commits: Commit[]): Promise<WriteResult> => {
			if (!online) throw new Error("Offline")
			await new Promise((resolve) => setTimeout(resolve, 10))
			return server.write(prefix, commits)
		},
		sync: async (prefix: any[], commits: Commit[], clock: number): Promise<SyncResult> => {
			if (!online) throw new Error("Offline")
			await new Promise((resolve) => setTimeout(resolve, 10))
			return server.sync(prefix, commits, clock)
		},
		read: async (prefix: any[], range: ListArgs<Tuple>, clock: number): Promise<ReadResult> => {
			if (!online) throw new Error("Offline")
			await new Promise((resolve) => setTimeout(resolve, 10))
			return server.read(prefix, range, clock)
		},
		fetch: async (prefix: any[], clock: number) => {
			if (!online) throw new Error("Offline")
			await new Promise((resolve) => setTimeout(resolve, 10))
			return server.fetch(prefix, clock)
		}
	}
}

describe("SyncDb Integration", () => {
	it("syncs between client and server", async () => {
		const serverDb = tupleDb()
		const reducers = {
			sendMessage: (db: any, msg: any) => {
				db.set(["inbox", msg.id], msg)
			},
		}

		const server = syncServer(serverDb, reducers)
		const api = createApi(server)
		const pubsub = createPubsub()

		const cache = new SyncCache({ api, pubsub })
		const session = cache.syncDb(["user", 1], reducers)

		// 1. Dispatch Optimistic Op
		const msg1 = { id: "msg1", fromId: 1, text: "hello" }
		session.write({}, ops => ops.sendMessage(msg1))

		// Verify optimistic update in Global Cache
		const key = ["user", 1, "data", "inbox", "msg1"]
		const cacheRes = cache.cache.list({ gte: key, lte: key })
		const val = cacheRes.hit?.[0]?.value

		assert.ok(val, "Value should be present in cache")
		assert.deepEqual(val, msg1, "Value should match msg1")

		await new Promise((resolve) => setTimeout(resolve, 50))

		// Verify applied to Server
		const serverKey = ["user", 1, "data", "inbox", "msg1"]
		const serverHit = serverDb
			.list()
			.find((item) => JSON.stringify(item.key) === JSON.stringify(serverKey))
		assert.ok(serverHit, "Item should be in server DB")

		// Client DB check
		const clientHit = session.data.list({ gte: ["inbox", "msg1"], lte: ["inbox", "msg1"] })
		assert.equal(clientHit.length, 1)
		assert.deepEqual(clientHit[0].value, msg1)
	})

	it("lazy fetch and partial sync", async () => {
		const serverDb = tupleDb()
		const reducers = {
			setDoc: (db: any, [k, v]: [any, any]) => db.set(k, v),
		}
		const server = syncServer(serverDb, reducers)
		const api = createApi(server)
		const pubsub = createPubsub()

		// Pre-populate server with data
		const serverUserDb = syncDb(serverDb.subspace(["user", 1]), reducers)
		serverUserDb.write({
			ops: [{ fn: "setDoc", args: [[["doc", "1"], "v1"]] }],
		})
		serverUserDb.write({
			ops: [{ fn: "setDoc", args: [[["doc", "2"], "v2"]] }],
		})
		serverUserDb.write({
			ops: [{ fn: "setDoc", args: [[["doc", "3"], "v3"]] }],
		})

		const cache = new SyncCache({ api, pubsub })
		const session = cache.syncDb(["user", 1], reducers)

		// 1. Dispatch optimistic write on client
		session.write({}, ops => ops.setDoc([["doc", "4"], "v4"]))

		// 2. Client requests range
		const { remote } = session.data.subscribe({ gte: ["doc", "1"], lte: ["doc", "2"] }, () => {})
		const results = await remote

		assert.equal(results.length, 2)
		assert.deepEqual(results[0].value, "v1")
		assert.deepEqual(results[1].value, "v2")

		assert.ok(session.syncedClock >= 3)

		const doc3 = session.data.list({ gte: ["doc", "3"], lte: ["doc", "3"] })
		// Doc 3 should be fetched because `read` calls `fetch` which gets all updates > clock.
		// `server.fetch` returns all history > 0.
		// serverUserDb history has ops for doc 1, 2, 3.
		// All are applied.
		assert.equal(doc3[0]?.value, "v3")

		const doc4 = session.data.list({ gte: ["doc", "4"], lte: ["doc", "4"] })
		assert.deepEqual(doc4[0].value, "v4")
	})

	it("server rejection / override handling", async () => {
		const serverDb = tupleDb()
		const reducers = {
			post: (db: any, { id, content }: any) => {
				// No longer have access to syncMetadata
				const time = new Date().toISOString()
				db.set(["posts", id], { content, time })
			},
		}

		const server = syncServer(serverDb, reducers)
		const api = createApi(server)
		const pubsub = createPubsub()

		const originalSync = api.sync.bind(api)
		api.sync = async (prefix, commits, clock) => {
			const newCommits = commits.map((c) => ({
				...c,
				createdAt: "9999-01-01T00:00:00.000Z",
			}))
			return originalSync(prefix, newCommits, clock)
		}

		const cache = new SyncCache({ api, pubsub })
		const session = cache.syncDb(["feed"], reducers)

		session.write({}, ops => ops.post({ id: "p1", content: "hello" }))

		// With syncMetadata removed, we can't easily test the "server override via metadata" scenario 
		// in the same way (where the reducer reads the committedAt time).
		// However, we can still verify that the sync happens and data eventually converges.
		
		await new Promise((r) => setTimeout(r, 50))

		const finalRes = session.data.list({ gte: ["posts", "p1"], lte: ["posts", "p1"] })
		assert.equal(finalRes[0].value.content, "hello")
	})

	it("write-only submission (offline recovery)", async () => {
		const serverDb = tupleDb()
		const reducers = {
			log: (db: any, msg: string) => db.set(["logs", Date.now()], msg),
		}
		const server = syncServer(serverDb, reducers)
		const api = createApi(server)

		// Direct write via transport/api
		const now = new Date().toISOString()
		const commits: Commit[] = [
			{
				id: "tx1",
				clock: 0,
				commitedAt: "",
				createdAt: now,
				ops: [{ fn: "log", args: ["recovered 1"] }],
			},
			{
				id: "tx2",
				clock: 0,
				commitedAt: "",
				createdAt: now,
				ops: [{ fn: "log", args: ["recovered 2"] }],
			},
		]

		const res = await api.write(["sys"], commits)

		assert.ok(res.clock >= 2)

		// Verify server applied them
		const sysDb = syncDb(serverDb.subspace(["sys"]), reducers)
		const history = sysDb.history.list()
		assert.equal(history.length, 2)
	})
})