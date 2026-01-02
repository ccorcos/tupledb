import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { tupleDb } from "../tupleDb/TupleDb"
import { syncDb } from "./SyncDb"
import { Commit } from "./types"

describe("SyncDb", () => {
	it("basic write tracking", () => {
		const db = tupleDb()
		const user = syncDb(db)

		assert.equal(user.clock(), 0)

		// 'set' is a default reducer
		user.write({
			authorId: "user1",
			ops: [{ fn: "set", args: [["name"], "chet"] }],
		})

		// Check clock incremented
		assert.equal(user.clock(), 1)

		// Check data written
		assert.equal(user.data.get(["name"]), "chet")

		// Check history
		const history = user.history.list()
		assert.equal(history.length, 1)
		const commit = history[0].value as Commit
		assert.equal(commit.clock, 1)
		assert.deepEqual(commit.ops[0], { fn: "set", args: [["name"], "chet"] })
	})

	it("batch writes", () => {
		const db = tupleDb()
		const user = syncDb(db)

		user.write({
			authorId: "user1",
			ops: [
				{ fn: "set", args: [["a"], 1] },
				{ fn: "set", args: [["b"], 2] },
				{ fn: "delete", args: [["c"]] },
			],
		})

		assert.equal(user.clock(), 1)
		assert.equal(user.data.get(["a"]), 1)
		assert.equal(user.data.get(["b"]), 2)

		const history = user.history.list()
		assert.equal(history.length, 1)
	})

	it("custom reducers", () => {
		const db = tupleDb()
		const reducers = {
			inc: (tx: any, key: any) => {
				const val = (tx.get(key) as number) || 0
				tx.set(key, val + 1)
			},
		}
		const user = syncDb(db, reducers)

		user.write({
			authorId: "user1",
			ops: [{ fn: "inc", args: [["count"]] }],
		})

		assert.equal(user.data.get(["count"]), 1)

		const history = user.history.list()
		assert.equal(history.length, 1)
		const commit = history[0].value as Commit
		assert.deepEqual(commit.ops[0], { fn: "inc", args: [["count"]] })
	})

	it("subspaces form independent sync units", () => {
		const db = tupleDb()
		const user = syncDb(db)

		// To get a scoped SyncDb, we wrap the subspace
		const inboxDb = db.subspace(["inbox"])
		const inbox = syncDb(inboxDb)

		inbox.write({
			authorId: "user1",
			ops: [{ fn: "set", args: [["msg1"], "hello"] }],
		})

		// Check clocks are independent
		assert.equal(user.clock(), 0)
		assert.equal(inbox.clock(), 1)
	})

	it("builder pattern write", () => {
		const db = tupleDb()
		const user = syncDb(db)

		user.write({ authorId: "user1" }, (ops) => {
			ops.set(["a"], 1)
			ops.set(["b"], 2)
		})

		assert.equal(user.clock(), 1)
		assert.equal(user.data.get(["a"]), 1)
		assert.equal(user.data.get(["b"]), 2)

		// Check history ops structure
		const commit = user.history.list()[0].value as Commit
		assert.deepEqual(commit.ops[0], { fn: "set", args: [["a"], 1] })
	})
})
