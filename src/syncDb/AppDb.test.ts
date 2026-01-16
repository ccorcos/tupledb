import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { tupleDb } from "../tupleDb/TupleDb"
import { TupleDb, Tuple } from "../tupleDb/types"
import { createAppDb, AppReducerMap } from "./AppDb"
import { applyCommit } from "./SyncServer"
import { defaultReducers } from "./SyncDb"

describe("AppDb", () => {
	// Helper to create a test reducer that writes to a single scope
	const createUserReducer = (tx: TupleDb, args: { id: string; name: string }) => {
		const scope: Tuple = ["users", args.id]
		applyCommit(tx.subspace(scope), defaultReducers, {
			id: `commit-${Date.now()}`,
			createdAt: new Date().toISOString(),
			clock: 0,
			commitedAt: "",
			ops: [{ fn: "set", args: [["profile"], { name: args.name }] }],
		})
		return { affectedScopes: [scope] }
	}

	// Helper that writes to multiple scopes
	const createPostReducer = (
		tx: TupleDb,
		args: { authorId: string; postId: string; title: string }
	) => {
		const postScope: Tuple = ["posts", args.postId]
		const userPostsScope: Tuple = ["users", args.authorId, "posts"]

		// Write to post scope
		applyCommit(tx.subspace(postScope), defaultReducers, {
			id: `commit-post-${Date.now()}`,
			createdAt: new Date().toISOString(),
			clock: 0,
			commitedAt: "",
			ops: [{ fn: "set", args: [["content"], { title: args.title, authorId: args.authorId }] }],
		})

		// Write to user's posts index
		applyCommit(tx.subspace(userPostsScope), defaultReducers, {
			id: `commit-userpost-${Date.now()}`,
			createdAt: new Date().toISOString(),
			clock: 0,
			commitedAt: "",
			ops: [{ fn: "set", args: [[args.postId], { title: args.title }] }],
		})

		return { affectedScopes: [postScope, userPostsScope] }
	}

	it("idempotent writes - same txId is skipped", async () => {
		const db = tupleDb()
		const appDb = createAppDb(db, { createUser: createUserReducer })

		// First write should succeed
		const result1 = await appDb.write("tx-1", [
			{ fn: "createUser", args: { id: "u1", name: "Alice" } },
		])
		assert.equal(result1.affectedScopes.length, 1)
		assert.deepEqual(result1.affectedScopes[0].scope, ["users", "u1"])

		// Same txId should be skipped
		const result2 = await appDb.write("tx-1", [
			{ fn: "createUser", args: { id: "u2", name: "Bob" } },
		])
		assert.equal(result2.affectedScopes.length, 0)

		// Different txId should succeed
		const result3 = await appDb.write("tx-2", [
			{ fn: "createUser", args: { id: "u2", name: "Bob" } },
		])
		assert.equal(result3.affectedScopes.length, 1)
		assert.deepEqual(result3.affectedScopes[0].scope, ["users", "u2"])
	})

	it("multi-scope dispatch", async () => {
		const db = tupleDb()
		const appDb = createAppDb(db, { createPost: createPostReducer })

		const result = await appDb.write("tx-1", [
			{ fn: "createPost", args: { authorId: "alice", postId: "p1", title: "Hello World" } },
		])

		assert.equal(result.affectedScopes.length, 2)
		assert.deepEqual(result.affectedScopes[0].scope, ["posts", "p1"])
		assert.deepEqual(result.affectedScopes[1].scope, ["users", "alice", "posts"])

		// Verify data was written
		const postData = db.subspace(["posts", "p1", "data"]).get(["content"])
		assert.deepEqual(postData, { title: "Hello World", authorId: "alice" })

		const userPostData = db.subspace(["users", "alice", "posts", "data"]).get(["p1"])
		assert.deepEqual(userPostData, { title: "Hello World" })
	})

	it("outbox entries created when configured", async () => {
		const db = tupleDb()
		const appDb = createAppDb(db, { createUser: createUserReducer }, { outboxPrefix: ["outbox"] })

		await appDb.write("tx-1", [{ fn: "createUser", args: { id: "u1", name: "Alice" } }])

		// Check outbox has an entry (use subspace to query by prefix)
		const outboxEntries = db.subspace(["outbox"]).list()
		assert.equal(outboxEntries.length, 1)

		const entry = outboxEntries[0].value as { scopes: { scope: Tuple; clock: number }[] }
		assert.equal(entry.scopes.length, 1)
		assert.deepEqual(entry.scopes[0].scope, ["users", "u1"])
		assert.equal(entry.scopes[0].clock, 1)
	})

	it("no outbox entry when no operations applied", async () => {
		const db = tupleDb()
		const appDb = createAppDb(db, { createUser: createUserReducer }, { outboxPrefix: ["outbox"] })

		// First write
		await appDb.write("tx-1", [{ fn: "createUser", args: { id: "u1", name: "Alice" } }])

		// Clear outbox for test
		const outbox = db.subspace(["outbox"])
		const entries = outbox.list()
		for (const { key } of entries) {
			outbox.delete(key)
		}

		// Duplicate write should not create outbox entry
		await appDb.write("tx-1", [{ fn: "createUser", args: { id: "u2", name: "Bob" } }])

		const outboxEntries = outbox.list()
		assert.equal(outboxEntries.length, 0)
	})

	it("multiple operations in single write", async () => {
		const db = tupleDb()
		const appDb = createAppDb(
			db,
			{ createUser: createUserReducer, createPost: createPostReducer },
			{ outboxPrefix: ["outbox"] }
		)

		const result = await appDb.write("tx-1", [
			{ fn: "createUser", args: { id: "alice", name: "Alice" } },
			{ fn: "createPost", args: { authorId: "alice", postId: "p1", title: "First Post" } },
		])

		// Should have 3 affected scopes: users/alice, posts/p1, users/alice/posts
		assert.equal(result.affectedScopes.length, 3)

		// Outbox should have entry with all scopes
		const outboxEntries = db.subspace(["outbox"]).list()
		assert.equal(outboxEntries.length, 1)
		const entry = outboxEntries[0].value as { scopes: { scope: Tuple; clock: number }[] }
		assert.equal(entry.scopes.length, 3)
	})
})
