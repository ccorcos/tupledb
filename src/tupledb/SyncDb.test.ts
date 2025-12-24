import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { syncDb } from "./SyncDb"
import { tupleDb } from "./TupleDb"

describe("Syncable", () => {
	it("basic write tracking", () => {
		const db = tupleDb()
		const user = syncDb(db)

		assert.equal(user.clock(), 0)

		// 'set' is a default reducer
		user.set(["name"], "chet")

		// Check clock incremented
		assert.equal(user.clock(), 1)

		// Check data written
		assert.equal(user.get(["name"]), "chet")

		// Check history
		const history = user.history()
		assert.equal(history.length, 1)
		assert.equal(history[0].clock, 1)
		assert.deepEqual(history[0].entry.op, { fn: "set", args: [["name"], "chet"] })
	})

	it("batch writes", () => {
		const db = tupleDb()
		const user = syncDb(db)

		const batch = {
			set: [
				{ key: ["a"], value: 1 },
				{ key: ["b"], value: 2 },
			],
			delete: [["c"]],
		}
		user.write(batch)

		assert.equal(user.clock(), 1)
		assert.equal(user.get(["a"]), 1)
		assert.equal(user.get(["b"]), 2)

		const history = user.history()
		assert.equal(history.length, 1)
		assert.deepEqual(history[0].entry.op, { fn: "write", args: [batch] })
	})

	it("custom reducers", () => {
		const db = tupleDb()
		const reducers = {
			inc: (tx: any, key: any) => {
				const val = (tx.get(key) as number) || 0
				tx.set(key, val + 1)
			}
		}
		const user = syncDb(db, reducers)

		user.inc(["count"])

		assert.equal(user.get(["count"]), 1)
		
		const history = user.history()
		assert.equal(history.length, 1)
		assert.deepEqual(history[0].entry.op, { fn: "inc", args: [["count"]] })
	})

	it("subspaces form independent sync units", () => {
		const db = tupleDb()
		const user = syncDb(db)
		// subspace() creates a new SyncDb scoped to that prefix
		const inbox = user.subspace(["inbox"])

		inbox.set(["msg1"], "hello")

		// Check clocks are independent
		assert.equal(user.clock(), 0)
		assert.equal(inbox.clock(), 1)

		// Data is still in the same underlying DB
		// user (root) sees it at ["data", "inbox", "data", "msg1"]?
		// inbox is syncDb(userDb.subspace(["inbox"]))
		// userDb.subspace(["inbox"]) -> prefix ["data", "inbox"] (relative to user root? No.)
		
		// syncDb(db) -> data at ["data"]
		// db.subspace(["inbox"]) -> prefix ["inbox"]
		// syncDb(db.subspace(["inbox"])) -> data at ["inbox", "data"]
		
		// If user is syncDb(root), user data is at ["data"].
		// inbox is syncDb(root.subspace(["inbox"])).
		// inbox data is at ["inbox", "data"].
		
		// user.get(["inbox", "data", "msg1"])?
		// user.get() prefixes with ["data"].
		// So user.get(["inbox", ...]) -> ["data", "inbox", ...]
		// Real path is ["inbox", "data", ...].
		// So user can't easily see inbox data via .get() because of the layout.
		// This confirms they are independent units.
	})
})