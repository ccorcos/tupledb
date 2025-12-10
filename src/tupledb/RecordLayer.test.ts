import { strict as assert } from "assert"
import { describe, it } from "node:test"
import { recordDb, RecordSchema } from "./RecordLayer"
import { tupleDb } from "./TupleDb"

// Define the types
type User = { type: "user"; id: string; name: string; bio: string }
type Post = { type: "post"; id: string; authorId: string; datetime: string; body: string }
type Follow = { type: "follow"; fromId: string; toId: string; datetime: string }
type Notification = {
	type: "notification"
	userId: string
	postId: string
	postDatetime: string
	read: boolean
}

type AppRecord = User | Post | Follow | Notification

const schema: RecordSchema = {
	types: {
		user: {
			primary: ["id"],
			indexes: {
				byName: ["name", "id"],
			},
		},
		post: {
			primary: ["id"],
			indexes: {
				byAuthor: ["authorId", "datetime", "id"],
			},
		},
		follow: {
			primary: ["fromId", "toId"],
			indexes: {
				byTo: ["toId", "fromId"],
			},
		},
		notification: {
			primary: ["userId", "postId"],
			indexes: {
				feed: ["userId", "postDatetime", "postId"],
			},
		},
	},
	aggregations: {
		userPostCount: {
			source: "post",
			groupBy: ["authorId"],
			kind: "count",
		},
		userFollowerCount: {
			source: "follow",
			groupBy: ["toId"],
			kind: "count",
		},
	},
	joins: {
		followersOfFollowers: {
			left: { type: "follow", on: "toId", index: "byTo" },
			right: { type: "follow", on: "fromId" }, // default primary
			key: [
				{ side: "right", field: "toId" }, // User
				{ side: "left", field: "fromId" }, // FoF
			],
		},
	},
}

describe("RecordLayer", () => {
	const db = tupleDb()
	const layer = recordDb(db, schema)

	it("should insert and retrieve a user", () => {
		const user: User = { type: "user", id: "u1", name: "Chet", bio: "Engineer" }
		layer.set(user)

		const fetched = layer.get("user", ["u1"])
		assert.deepEqual(fetched, user)
	})

	it("should update indexes when modifying a user", () => {
		const user: User = { type: "user", id: "u1", name: "Chet", bio: "Engineer" }
		layer.set(user)

		// Check index
		const indexKey = ["user", "byName", "Chet", "u1"]
		assert.equal(db.get(indexKey), null)

		// Update user
		const updated: User = { ...user, name: "Chester" }
		layer.set(updated)

		// Old index should be gone
		assert.equal(db.get(indexKey), undefined)

		// New index should exist
		const newIndexKey = ["user", "byName", "Chester", "u1"]
		assert.equal(db.get(newIndexKey), null)
	})

	it("should handle secondary lookups", () => {
		const user1: User = { type: "user", id: "u1", name: "Alice", bio: "" }
		const user2: User = { type: "user", id: "u2", name: "Bob", bio: "" }
		const user3: User = { type: "user", id: "u3", name: "Alice", bio: "Another Alice" }

		layer.set(user1)
		layer.set(user2)
		layer.set(user3)

		// Scan index
		const results = layer.subspace(["user", "byName"]).list({ prefix: ["Alice"] })
		assert.equal(results.length, 2)
		assert.deepEqual(results[0], user1)
		assert.deepEqual(results[1], user3)
	})

	it("should maintain a count of posts per user", () => {
		const post1: Post = {
			type: "post",
			id: "p1",
			authorId: "u1",
			datetime: "2023-01-01",
			body: "Hello",
		}
		const post2: Post = {
			type: "post",
			id: "p2",
			authorId: "u1",
			datetime: "2023-01-02",
			body: "World",
		}
		const post3: Post = {
			type: "post",
			id: "p3",
			authorId: "u2",
			datetime: "2023-01-03",
			body: "Test",
		}

		assert.equal(layer.getAggregation("userPostCount", ["u1"]), 0)

		layer.set(post1)
		assert.equal(layer.getAggregation("userPostCount", ["u1"]), 1)

		layer.set(post2)
		assert.equal(layer.getAggregation("userPostCount", ["u1"]), 2)
		assert.equal(layer.getAggregation("userPostCount", ["u2"]), 0)

		layer.set(post3)
		assert.equal(layer.getAggregation("userPostCount", ["u2"]), 1)

		// Delete a post
		layer.delete("post", ["p1"])
		assert.equal(layer.getAggregation("userPostCount", ["u1"]), 1)

		// Move a post to another author (unlikely for posts, but tests logic)
		const post2Moved = { ...post2, authorId: "u2" }
		layer.set(post2Moved)
		// u1 should decr (1 -> 0), u2 should incr (1 -> 2)
		assert.equal(layer.getAggregation("userPostCount", ["u1"]), 0)
		assert.equal(layer.getAggregation("userPostCount", ["u2"]), 2)
	})

	it("should index followers of followers", () => {
		const f1: Follow = { type: "follow", fromId: "A", toId: "B", datetime: "t1" }
		const f2: Follow = { type: "follow", fromId: "B", toId: "C", datetime: "t2" }
		const f3: Follow = { type: "follow", fromId: "C", toId: "D", datetime: "t3" }

		// A -> B -> C -> D
		// FoF for C should include A.
		// FoF for D should include B.

		layer.set(f1)
		layer.set(f2)

		// Check C's FoFs
		const cFofs = layer
			.subspace(["join", "followersOfFollowers", "C"])
			.list()
			.map((item) => item.key)
		assert.deepEqual(cFofs, [["A"]])

		layer.set(f3)
		const dFofs = layer
			.subspace(["join", "followersOfFollowers", "D"])
			.list()
			.map((item) => item.key)
		assert.deepEqual(dFofs, [["B"]])

		// Delete B -> C
		layer.delete("follow", ["B", "C"])

		// C's FoFs should be empty (link broken)
		// A -> B   ...   C -> D
		// A is still connected to B. But B is not connected to C.
		// So A is NOT a FoF of C anymore.

		const cFofsAfter = layer
			.subspace(["join", "followersOfFollowers", "C"])
			.list()
			.map((item) => item.key)
		assert.deepEqual(cFofsAfter, [])

		// D's FoF was B (via C). C->D exists. B->C deleted.
		// Wait, B->C was the link from B to D?
		// Chain: B -> C -> D.
		// Left(B->C), Right(C->D).
		// If B->C deleted. Left deleted. Join entry [D, B] should be deleted.
		const dFofsAfter = layer
			.subspace(["join", "followersOfFollowers", "D"])
			.list()
			.map((item) => item.key)
		assert.deepEqual(dFofsAfter, [])
	})
})
