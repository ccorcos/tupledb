import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { tupleDb } from "../tupleDb/TupleDb"
import { ListArgs, Tuple } from "../tupleDb/types"
import { SyncClient } from "./SyncClient"
import { syncDb } from "./SyncDb"
import { syncServer } from "./SyncServer"
import { Commit, JSONValue, Pubsub, ReadResult, SyncApi, SyncResult, WriteResult } from "./types"

// Mock Pubsub
const createPubsub = (): Pubsub => {
	const listeners = new Set<{ tuple: Tuple; listener: (t: Tuple, v: JSONValue) => void }>()
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
		},
	}
}

// Mock API (formerly transport)
const createApi = (server: any): SyncApi & { setOnline: (status: boolean) => void } => {
	let online = true
	return {
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
		},
	}
}

describe("SyncDb Integration", () => {
	it("syncs between client and server", async () => {
		const serverDb = tupleDb()

		// Global Reducers
		const reducers = {
			sendMessage: (tx: any, userId: number, msg: any) => {
				// Fanout to user SyncDb
				// We use syncDb wrapper to generate proper Local Commits/Data structure
				const userDb = syncDb(tx.subspace(["user", userId]))
				userDb.write((ops: any) => {
					// Local Reducer logic (inline)
					ops.set(["inbox", msg.id], msg)
				})
			},
		}

		// Server must use 'useDataSubspace: false' to allow Global Reducers to access root
		const server = syncServer(serverDb, reducers, { useDataSubspace: false })
		const api = createApi(server)
		const pubsub = createPubsub()

		const client = new SyncClient({ api, pubsub, reducers })
		// We can use local reducers for the session view if we want,
		// but typically Session just reads data.
		// For the test, we don't strictly need local reducers if we don't apply local updates via session.write.
		const session = client.syncDb(["user", 1], {})

		// 1. Dispatch Optimistic Op (Global)
		const msg1 = { id: "msg1", fromId: 1, text: "hello" }
		client.write({}, (ops) => ops.sendMessage(1, msg1))

		// Verify optimistic update in Global Cache
		// Logic: Global Write -> Local Commit -> Data Write
		// Local Commit writes to ["user", 1, "history", ...]
		// Data Write writes to ["user", 1, "data", "inbox", "msg1"]
		// Note: SyncClient.cache is the root cache.
		const key = ["user", 1, "data", "inbox", "msg1"]
		const cacheRes = client.cache.list({ gte: key, lte: key })
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

		// Client DB check (Session View)
		const clientHit = session.data.list({ gte: ["inbox", "msg1"], lte: ["inbox", "msg1"] })
		assert.equal(clientHit.length, 1)
		assert.deepEqual(clientHit[0].value, msg1)
	})

	it("lazy fetch and partial sync", async () => {
		const serverDb = tupleDb()
		// Server Reducers (Global/Local mixed use for setup)
		const reducers = {
			setDoc: (tx: any, userId: number, k: any, v: any) => {
				const userDb = syncDb(tx.subspace(["user", userId]))
				userDb.write((ops: any) => ops.set(k, v))
			},
		}

		const server = syncServer(serverDb, reducers, { useDataSubspace: false })
		const api = createApi(server)
		const pubsub = createPubsub()

		// Pre-populate server with data
		// We can use the server's syncDb wrapper directly?
		// No, we need to bypass SyncServer's `write` to simulate existing data?
		// Or just use api.write with Global Commit.

		// Let's use SyncDb on the serverDb directly to populate "Local" data.
		// This simulates data that exists before the client connects.
		const serverUserDb = syncDb(serverDb.subspace(["user", 1])) // Local SyncDb
		serverUserDb.write((ops: any) => ops.set(["doc", "1"], "v1"))
		serverUserDb.write((ops: any) => ops.set(["doc", "2"], "v2"))
		serverUserDb.write((ops: any) => ops.set(["doc", "3"], "v3"))

		const client = new SyncClient({ api, pubsub, reducers })
		const session = client.syncDb(["user", 1], {})

		// 1. Dispatch optimistic write on client
		client.write({}, (ops) => ops.setDoc(1, ["doc", "4"], "v4"))

		// 2. Client requests range
		const { remote } = session.data.subscribe({ gte: ["doc", "1"], lte: ["doc", "2"] }, () => {})
		const results = await remote

		assert.equal(results.length, 2)
		assert.deepEqual(results[0].value, "v1")
		assert.deepEqual(results[1].value, "v2")

		assert.ok(session.clock() >= 3)

		const doc3 = session.data.list({ gte: ["doc", "3"], lte: ["doc", "3"] })
		assert.equal(doc3[0]?.value, "v3")

		const doc4 = session.data.list({ gte: ["doc", "4"], lte: ["doc", "4"] })
		assert.deepEqual(doc4[0].value, "v4")
	})

	it("server rejection / override handling", async () => {
		const serverDb = tupleDb()
		const reducers = {
			post: (tx: any, id: string, content: string) => {
				const db = syncDb(tx.subspace(["feed"]))
				db.write((ops: any) => {
					const time = new Date().toISOString()
					ops.set(["posts", id], { content, time })
				})
			},
		}

		const server = syncServer(serverDb, reducers, { useDataSubspace: false })
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

		const client = new SyncClient({ api, pubsub, reducers })
		const session = client.syncDb(["feed"], {})

		client.write({}, (ops) => ops.post("p1", "hello"))

		await new Promise((r) => setTimeout(r, 50))

		const finalRes = session.data.list({ gte: ["posts", "p1"], lte: ["posts", "p1"] })
		assert.equal(finalRes[0].value.content, "hello")
	})

	it("write-only submission (offline recovery)", async () => {
		const serverDb = tupleDb()
		const reducers = {
			log: (db: any, msg: string) => db.set(["logs", Date.now()], msg),
		}
		// Standard SyncServer (not global)
		const server = syncServer(serverDb, reducers, { useDataSubspace: true })
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
