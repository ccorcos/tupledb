import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { recordDb, RecordDbSchema } from "./RecordLayer"
import { tupleDb } from "./TupleDb"

// Define the types
type User = { type: "user"; id: string; name: string; bio: string }
type Post = { type: "post"; id: string; authorId: string; datetime: string; body: string }
type Follow = { type: "follow"; fromId: string; toId: string; datetime: string }

const schema: RecordDbSchema = {
	records: {
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

		const fetched = layer.get({ type: "user", id: "u1" })
		assert.deepEqual(fetched, user)
	})

	it("should update indexes when modifying a user", () => {
		const user: User = { type: "user", id: "u1", name: "Chet", bio: "Engineer" }
		layer.set(user)

		// Check index via tupleDb directly
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

	it("should handle secondary lookups via query", () => {
		const user1: User = { type: "user", id: "u1", name: "Alice", bio: "" }
		const user2: User = { type: "user", id: "u2", name: "Bob", bio: "" }
		const user3: User = { type: "user", id: "u3", name: "Alice", bio: "Another Alice" }

		layer.set(user1)
		layer.set(user2)
		layer.set(user3)

		// Scan index using query
		const results = layer.query({
			from: "user",
			where: { name: "Alice" },
		})
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

		// Initial check using query with explicit aggregation
		assert.equal(layer.query({
			from: "post",
			groupBy: ["authorId"],
			aggregate: { count: "count" },
			where: { authorId: "u1" }
		}).count, 0)

		layer.set(post1)
		assert.equal(layer.query({
			from: "post",
			groupBy: ["authorId"],
			aggregate: { count: "count" },
			where: { authorId: "u1" }
		}).count, 1)

		layer.set(post2)
		assert.equal(layer.query({
			from: "post",
			groupBy: ["authorId"],
			aggregate: { count: "count" },
			where: { authorId: "u1" }
		}).count, 2)
		
		assert.equal(layer.query({
			from: "post",
			groupBy: ["authorId"],
			aggregate: { count: "count" },
			where: { authorId: "u2" }
		}).count, 0)

		layer.set(post3)
		assert.equal(layer.query({
			from: "post",
			groupBy: ["authorId"],
			aggregate: { count: "count" },
			where: { authorId: "u2" }
		}).count, 1)

		// Delete a post
		layer.delete({ type: "post", id: "p1" })
		assert.equal(layer.query({
			from: "post",
			groupBy: ["authorId"],
			aggregate: { count: "count" },
			where: { authorId: "u1" }
		}).count, 1)

		// Move a post
		const post2Moved = { ...post2, authorId: "u2" }
		layer.set(post2Moved)
		assert.equal(layer.query({
			from: "post",
			groupBy: ["authorId"],
			aggregate: { count: "count" },
			where: { authorId: "u1" }
		}).count, 0)
		assert.equal(layer.query({
			from: "post",
			groupBy: ["authorId"],
			aggregate: { count: "count" },
			where: { authorId: "u2" }
		}).count, 2)
	})

	it("should index followers of followers", () => {
		const f1: Follow = { type: "follow", fromId: "A", toId: "B", datetime: "t1" }
		const f2: Follow = { type: "follow", fromId: "B", toId: "C", datetime: "t2" }
		const f3: Follow = { type: "follow", fromId: "C", toId: "D", datetime: "t3" }

		layer.set(f1)
		layer.set(f2)

		// Check C's FoFs using query on join
		const cFofs = layer.query({
			from: "followersOfFollowers",
			where: { toId: "C" }
		})
		assert.equal(cFofs.length, 1)
		assert.equal(cFofs[0].fromId, "A")
		assert.equal(cFofs[0].toId, "C")

		layer.set(f3)
		const dFofs = layer.query({
			from: "followersOfFollowers",
			where: { toId: "D" }
		})
		assert.equal(dFofs.length, 1)
		assert.equal(dFofs[0].fromId, "B")

		// Delete B -> C
		layer.delete({ type: "follow", fromId: "B", toId: "C" })

		const cFofsAfter = layer.query({
			from: "followersOfFollowers",
			where: { toId: "C" }
		})
		assert.equal(cFofsAfter.length, 0)

		const dFofsAfter = layer.query({
			from: "followersOfFollowers",
			where: { toId: "D" }
		})
		assert.equal(dFofsAfter.length, 0)
	})
})