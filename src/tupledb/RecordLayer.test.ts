import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { JoinSchema, recordDb, RecordDbSchema } from "./RecordLayer"
import { tupleDb } from "./TupleDb"

// Define the types
type User = { type: "user"; id: string; name: string; bio: string }
type Post = { type: "post"; id: string; authorId: string; datetime: string; body: string }
type Follow = { type: "follow"; fromId: string; toId: string; datetime: string }

const schema: RecordDbSchema = {
	records: {
		user: {
			primary: ["id"],
		},
		post: {
			primary: ["id"],
		},
		follow: {
			primary: ["fromId", "toId"],
		},
		notification: {
			primary: ["userId", "postId"],
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

		// Trigger index creation
		layer.query({ from: "user", where: { name: "Chet" } })

		// Check index via tupleDb directly
		// Index name: auto_idx_name_id
		const indexKey = ["user", "auto_idx_name_id", "Chet", "u1"]
		assert.equal(db.get(indexKey), null)

		// Update user
		const updated: User = { ...user, name: "Chester" }
		layer.set(updated)

		// Old index should be gone
		assert.equal(db.get(indexKey), undefined)

		// New index should exist
		const newIndexKey = ["user", "auto_idx_name_id", "Chester", "u1"]
		assert.equal(db.get(newIndexKey), null)
	})

	it("should handle secondary lookups via query", () => {
		const user1: User = { type: "user", id: "u1", name: "Alice", bio: "" }
		const user2: User = { type: "user", id: "u2", name: "Bob", bio: "" }
		const user3: User = { type: "user", id: "u3", name: "Alice", bio: "Another Alice" }

		layer.set(user1)
		layer.set(user2)
		layer.set(user3)

		// Scan index using query (triggers index creation)
		const results = layer.query({
			from: "user",
			where: { name: "Alice" },
		})
		assert.equal(results.length, 2)
		assert.deepEqual(results[0], user1)
		assert.deepEqual(results[1], user3)

		// Assert index generation
		const s = db.get(["_schema", "current"]) as RecordDbSchema
		assert.ok(s.records.user.indexes?.["auto_idx_name_id"])
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
		assert.equal(
			layer.query({
				from: "post",
				groupBy: ["authorId"],
				aggregate: { count: "count" },
				where: { authorId: "u1" },
			}).count,
			0
		)

		layer.set(post1)
		assert.equal(
			layer.query({
				from: "post",
				groupBy: ["authorId"],
				aggregate: { count: "count" },
				where: { authorId: "u1" },
			}).count,
			1
		)

		layer.set(post2)
		assert.equal(
			layer.query({
				from: "post",
				groupBy: ["authorId"],
				aggregate: { count: "count" },
				where: { authorId: "u1" },
			}).count,
			2
		)

		assert.equal(
			layer.query({
				from: "post",
				groupBy: ["authorId"],
				aggregate: { count: "count" },
				where: { authorId: "u2" },
			}).count,
			0
		)

		layer.set(post3)
		assert.equal(
			layer.query({
				from: "post",
				groupBy: ["authorId"],
				aggregate: { count: "count" },
				where: { authorId: "u2" },
			}).count,
			1
		)

		// Delete a post
		layer.delete({ type: "post", id: "p1" })
		assert.equal(
			layer.query({
				from: "post",
				groupBy: ["authorId"],
				aggregate: { count: "count" },
				where: { authorId: "u1" },
			}).count,
			1
		)

		// Move a post
		const post2Moved = { ...post2, authorId: "u2" }
		layer.set(post2Moved)
		assert.equal(
			layer.query({
				from: "post",
				groupBy: ["authorId"],
				aggregate: { count: "count" },
				where: { authorId: "u1" },
			}).count,
			0
		)
		assert.equal(
			layer.query({
				from: "post",
				groupBy: ["authorId"],
				aggregate: { count: "count" },
				where: { authorId: "u2" },
			}).count,
			2
		)
	})

	it("should index followers of followers", () => {
		const f1: Follow = { type: "follow", fromId: "A", toId: "B", datetime: "t1" }
		const f2: Follow = { type: "follow", fromId: "B", toId: "C", datetime: "t2" }
		const f3: Follow = { type: "follow", fromId: "C", toId: "D", datetime: "t3" }

		layer.set(f1)
		layer.set(f2)

		const joinDef: JoinSchema = {
			left: { type: "follow", on: "toId" },
			right: { type: "follow", on: "fromId" },
			key: [
				{ side: "right", field: "toId" }, // User
				{ side: "left", field: "fromId" }, // FoF
			],
		}

		// Check C's FoFs using query on join
		const cFofs = layer.query({
			from: joinDef,
			where: { toId: "C" },
		})
		assert.equal(cFofs.length, 1)
		assert.equal(cFofs[0].fromId, "A")
		assert.equal(cFofs[0].toId, "C")

		layer.set(f3)
		const dFofs = layer.query({
			from: joinDef, // Reuse definition
			where: { toId: "D" },
		})
		assert.equal(dFofs.length, 1)
		assert.equal(dFofs[0].fromId, "B")

		// Assert Schema generated
		const s = db.get(["_schema", "current"]) as RecordDbSchema
		const joinName = `auto_join_follow_toId_follow_fromId`
		assert.ok(s.joins?.[joinName])
		assert.ok(s.records.follow.indexes?.["auto_idx_toId_fromId"]) // Left Side Index

		// Delete B -> C
		layer.delete({ type: "follow", fromId: "B", toId: "C" })

		const cFofsAfter = layer.query({
			from: joinDef,
			where: { toId: "C" },
		})
		assert.equal(cFofsAfter.length, 0)

		const dFofsAfter = layer.query({
			from: joinDef,
			where: { toId: "D" },
		})
		assert.equal(dFofsAfter.length, 0)
	})

	it("should filter results when query includes fields not in the index/primary key", () => {
		const user: User = { type: "user", id: "u99", name: "Target", bio: "Match" }
		layer.set(user)

		// 1. Query by Primary Key + Mismatching Field
		// The primary key 'id' matches, but 'bio' does not.
		// If scanSmart doesn't filter, it will return the user because it does a direct db.get().
		const results = layer.query({
			from: "user",
			where: { id: "u99", bio: "NoMatch" },
		})

		assert.equal(results.length, 0, "Should return 0 results due to mismatched 'bio'")

		// 2. Query by Primary Key + Matching Field
		const resultsMatch = layer.query({
			from: "user",
			where: { id: "u99", bio: "Match" },
		})
		assert.equal(resultsMatch.length, 1)
		assert.deepEqual(resultsMatch[0], user)
	})

	it("should support timeline and identity feeds via joins", () => {
		// Users
		const me: User = { type: "user", id: "uMe", name: "Me", bio: "" }
		const uA: User = { type: "user", id: "uA", name: "UA", bio: "" }
		const uB: User = { type: "user", id: "uB", name: "UB", bio: "" }
		layer.set(me)
		layer.set(uA)
		layer.set(uB)

		// Follows
		// Me follows UA
		layer.set({ type: "follow", fromId: "uMe", toId: "uA", datetime: "t0" })
		// UB follows Me
		layer.set({ type: "follow", fromId: "uB", toId: "uMe", datetime: "t0" })

		// Posts
		const pA1: Post = {
			type: "post",
			id: "pA1",
			authorId: "uA",
			datetime: "2023-01-01",
			body: "UA Post",
		}
		const pB1: Post = {
			type: "post",
			id: "pB1",
			authorId: "uB",
			datetime: "2023-01-02",
			body: "UB Post",
		}
		// My post
		const pMe1: Post = {
			type: "post",
			id: "pMe1",
			authorId: "uMe",
			datetime: "2023-01-03",
			body: "My Post",
		}

		layer.set(pA1)
		layer.set(pB1)
		layer.set(pMe1)

		// Timeline Feed: Posts by people I follow.
		// I follow UA. I should see pA1.
		const timelineJoin: JoinSchema = {
			left: { type: "follow", on: "toId" },
			right: { type: "post", on: "authorId" },
			key: [
				{ side: "left", field: "fromId" }, // Me (subscriber)
				{ side: "right", field: "datetime" }, // Time
				{ side: "right", field: "id" },
			],
		}

		const timeline = layer.query({
			from: timelineJoin,
			where: { fromId: "uMe" },
		})

		assert.equal(timeline.length, 1)
		assert.equal(timeline[0].id, "pA1")

		const fetchedP1 = layer.get({ type: "post", id: timeline[0].id })
		assert.equal(fetchedP1.body, "UA Post")

		// Check ordering if we add another post
		const pA2: Post = {
			type: "post",
			id: "pA2",
			authorId: "uA",
			datetime: "2023-01-04",
			body: "UA Post 2",
		}
		layer.set(pA2)

		const timeline2 = layer.query({
			from: timelineJoin,
			where: { fromId: "uMe" },
		})
		assert.equal(timeline2.length, 2)
		// Order should be by datetime ascending
		assert.equal(timeline2[0].id, "pA1")
		assert.equal(timeline2[1].id, "pA2")

		// Identity Feed: Posts by people who follow me.
		const identityFeed = layer.query({
			from: {
				left: { type: "follow", on: "fromId" }, // Match follow.fromId
				right: { type: "post", on: "authorId" }, // with post.authorId
				key: [
					{ side: "left", field: "toId" }, // Me (broadcaster)
					{ side: "right", field: "datetime" },
					{ side: "right", field: "id" },
				],
			},
			where: { toId: "uMe" },
		})

		// UB follows Me. I should see pB1.
		assert.equal(identityFeed.length, 1)
		assert.equal(identityFeed[0].id, "pB1")
	})
})
