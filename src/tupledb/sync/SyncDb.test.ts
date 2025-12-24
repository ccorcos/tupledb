import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { tupleDb } from "../TupleDb"
import { SyncManager } from "./SyncClient"
import { SyncServer } from "./SyncServer"
import { SyncResult, ReadResult, WriteResult } from "./types"
import { syncDb } from "../SyncDb"
import { ListArgs, Tuple } from "../types"

// Mock transport
const createTransport = (server: SyncServer) => {
	let online = true
	return {
		setOnline: (status: boolean) => (online = status),
		write: async (prefix: any[], ops: any[]): Promise<WriteResult> => {
			if (!online) throw new Error("Offline")
			await new Promise((resolve) => setTimeout(resolve, 10))
			return server.write(prefix, ops)
		},
		sync: async (prefix: any[], ops: any[], clock: number): Promise<SyncResult> => {
			if (!online) throw new Error("Offline")
			await new Promise((resolve) => setTimeout(resolve, 10))
			return server.sync(prefix, ops, clock)
		},
		read: async (prefix: any[], range: ListArgs<Tuple>, clock: number): Promise<ReadResult> => {
			if (!online) throw new Error("Offline")
			await new Promise((resolve) => setTimeout(resolve, 10))
			return server.read(prefix, range, clock)
		}
	}
}

describe("SyncDb", () => {
	it("syncs between client and server", async () => {
		const serverDb = tupleDb()
		const reducers = {
			sendMessage: (db: any, msg: any) => {
				db.set(["inbox", msg.id], msg)
			},
		}

		const server = new SyncServer(serverDb, reducers)
		const transport = createTransport(server)

		const clientDb = tupleDb()
		const manager = new SyncManager({
			db: clientDb,
			reducers,
			transport,
		})

		const session = manager.session(["user", 1])

		// 1. Dispatch Optimistic Op
		const msg1 = { id: "msg1", fromId: 1, text: "hello" }
		session.dispatch("sendMessage", msg1)

		// Verify optimistic update in Global Cache
		const key = ["user", 1, "data", "inbox", "msg1"]
		const cacheRes = manager.cache.list({ gte: key, lte: key })
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
		const clientHit = clientDb
			.list()
			.find((item) => JSON.stringify(item.key) === JSON.stringify(key))
		assert.ok(clientHit, "Item should be in client DB at data path")
	})

	it("lazy fetch and partial sync", async () => {
		const serverDb = tupleDb()
		const reducers = {
			setDoc: (db: any, k: any, v: any) => db.set(k, v)
		}
		const server = new SyncServer(serverDb, reducers)
		const transport = createTransport(server)

		// Pre-populate server with data
		const serverUserDb = syncDb(serverDb.subspace(["user", 1]), reducers)
		serverUserDb.setDoc(["doc", "1"], "v1") // clock 1
		serverUserDb.setDoc(["doc", "2"], "v2") // clock 2
		serverUserDb.setDoc(["doc", "3"], "v3") // clock 3

		const clientDb = tupleDb()
		const manager = new SyncManager({
			db: clientDb,
			reducers,
			transport,
		})
		const session = manager.session(["user", 1])

		// 1. Dispatch optimistic write on client
		session.dispatch("setDoc", ["doc", "4"], "v4") // pending...

		// 2. Client requests range
		const results = await session.list({ gte: ["doc", "1"], lte: ["doc", "2"] })
		
		assert.equal(results.length, 2)
		assert.deepEqual(results[0].value, "v1")
		assert.deepEqual(results[1].value, "v2")
		
		assert.ok(session.syncedClock >= 3)
		
		const doc3Key = ["user", 1, "data", "doc", "3"]
		assert.equal(clientDb.get(doc3Key), "v3")

		const doc4 = await session.list({ gte: ["doc", "4"], lte: ["doc", "4"] })
		assert.deepEqual(doc4[0].value, "v4")
	})

	it("server rejection / override handling", async () => {
		const serverDb = tupleDb()
		const reducers = {
			post: (db: any, id: string, content: string) => {
				const time = db.syncMetadata?.timestamp ?? 0
				db.set(["posts", id], { content, time })
			}
		}
		
		const server = new SyncServer(serverDb, reducers)
		const transport = createTransport(server)
		
		const originalSync = transport.sync
		transport.sync = (prefix, ops, clock) => {
			const newOps = ops.map(op => ({
				...op,
				metadata: { ...op.metadata, timestamp: 9999 }
			}))
			return originalSync(prefix, newOps, clock)
		}

		const clientDb = tupleDb()
		const manager = new SyncManager({ db: clientDb, reducers, transport })
		const session = manager.session(["feed"])

		const realDateNow = Date.now
		Date.now = () => 100
		session.dispatch("post", "p1", "hello")
		Date.now = realDateNow

		const optRes = await session.list({ gte: ["posts", "p1"], lte: ["posts", "p1"] })
		assert.equal(optRes[0].value.time, 100)

		await new Promise((r) => setTimeout(r, 50))

		const finalRes = await session.list({ gte: ["posts", "p1"], lte: ["posts", "p1"] })
		assert.equal(finalRes[0].value.time, 9999)
	})

	it("write-only submission (offline recovery)", async () => {
		const serverDb = tupleDb()
		const reducers = {
			log: (db: any, msg: string) => db.set(["logs", Date.now()], msg)
		}
		const server = new SyncServer(serverDb, reducers)
		const transport = createTransport(server)

		// Direct write via transport (simulating a recovery script)
		const ops = [
			{ metadata: { txId: "tx1" }, op: { fn: "log", args: ["recovered 1"] } },
			{ metadata: { txId: "tx2" }, op: { fn: "log", args: ["recovered 2"] } }
		]
		
		const res = await transport.write(["sys"], ops as any)
		
		assert.ok(res.clock >= 2)
		
		// Verify server applied them
		const sysDb = syncDb(serverDb.subspace(["sys"]), reducers)
		const history = sysDb.history()
		assert.equal(history.length, 2)
		assert.deepEqual(history[0].value.op.args, ["recovered 1"])
		assert.deepEqual(history[1].value.op.args, ["recovered 2"])
	})
})