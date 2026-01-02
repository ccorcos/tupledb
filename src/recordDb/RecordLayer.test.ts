import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { tupleDb } from "../tupleDb/TupleDb"
import { TupleDb } from "../tupleDb/types"
import { recordDb, Schema } from "./RecordLayer"

// Types for the social app
type User = { type: "user"; id: string; name: string; age?: number; bio?: string }
type Post = { type: "post"; id: string; authorId: string; createdAt: string; body: string }
type Follow = { type: "follow"; fromId: string; toId: string; createdAt?: string }

const schema: Schema = {
	types: {
		user: { primary: ["id"] },
		post: { primary: ["id"] },
		follow: { primary: ["fromId", "toId"] },
	},
	indexes: {},
}

function setup(db: TupleDb) {
	const layer = recordDb(db)
	for (const [name, def] of Object.entries(schema.types)) {
		layer.createType(name, def)
	}
	return layer
}

describe("TupleDB Query Syntax V5", () => {
	it("1. Simple Lookup (User by Name)", () => {
		const db = tupleDb()
		const layer = setup(db)

		layer.set({ type: "user", id: "u1", name: "Chet" })
		layer.set({ type: "user", id: "u2", name: "Bob" })

		const q = {
			match: {
				u: { from: "user" },
			},
			sort: ["u.name", "u.id"],
		}

		const res = layer.query(q)
		assert.equal(res.length, 2)
		assert.equal(res[0]["u.name"], "Bob")
		assert.equal(res[1]["u.name"], "Chet")
	})

	it("2. Paged Sort (User by Age)", () => {
		const db = tupleDb()
		const layer = setup(db)

		layer.set({ type: "user", id: "u1", name: "A", age: 10 })
		layer.set({ type: "user", id: "u2", name: "B", age: 20 })
		layer.set({ type: "user", id: "u3", name: "C", age: 30 })

		const q = {
			match: { u: { from: "user" } },
			where: { "u.age": { gt: 18 } },
			sort: ["u.age", "u.id"],
		}

		const res = layer.query(q)
		assert.equal(res.length, 2)
		assert.equal(res[0]["u.age"], 20)
		assert.equal(res[1]["u.age"], 30)
	})

	it("3. Multi-Attribute Lookup (User by Name & Bio)", () => {
		const db = tupleDb()
		const layer = setup(db)

		layer.set({ type: "user", id: "u1", name: "A", bio: "Z" })
		layer.set({ type: "user", id: "u2", name: "A", bio: "Y" }) // Should come first if sorted by bio

		const q = {
			match: { u: { from: "user" } },
			sort: ["u.name", "u.bio", "u.id"],
		}

		const res = layer.query(q)
		assert.equal(res.length, 2)
		assert.equal(res[0]["u.bio"], "Y")
		assert.equal(res[1]["u.bio"], "Z")
	})

	it("4. Grouping & Counting (Unique Bios)", () => {
		const db = tupleDb()
		const layer = setup(db)

		layer.set({ type: "user", id: "u1", name: "A", bio: "Dev" })
		layer.set({ type: "user", id: "u2", name: "B", bio: "Dev" })
		layer.set({ type: "user", id: "u3", name: "C", bio: "Designer" })

		const q = {
			match: { u: { from: "user" } },
			reduce: {
				groupBy: ["u.bio"],
				aggregate: {
					userCount: { count: "u.id" },
				},
			},
			sort: ["u.bio"],
		}

		const res = layer.query(q)
		assert.equal(res.length, 2)
		assert.deepEqual(res[0], { "u.bio": "Designer", userCount: 1 })
		assert.deepEqual(res[1], { "u.bio": "Dev", userCount: 2 })
	})

	it("5. Aggregated Sort (Users ordered by Latest Post)", () => {
		const db = tupleDb()
		const layer = setup(db)

		layer.set({ type: "user", id: "u1", name: "A" })
		layer.set({ type: "user", id: "u2", name: "B" })

		layer.set({ type: "post", id: "p1", authorId: "u1", createdAt: "2023-01-01", body: "." })
		layer.set({ type: "post", id: "p2", authorId: "u1", createdAt: "2023-01-03", body: "." })
		layer.set({ type: "post", id: "p3", authorId: "u2", createdAt: "2023-01-02", body: "." })

		const q = {
			match: {
				u: { from: "user" },
				p: { from: "post", on: { authorId: "u.id" } },
			},
			reduce: {
				groupBy: ["u.id"],
				aggregate: {
					latestPostAt: { max: "p.createdAt" },
				},
			},
			sort: ["latestPostAt", "u.id"],
		}

		const res = layer.query(q)
		assert.equal(res.length, 2)
		assert.equal(res[0]["u.id"], "u2")
		assert.equal(res[0].latestPostAt, "2023-01-02")
		assert.equal(res[1]["u.id"], "u1")
		assert.equal(res[1].latestPostAt, "2023-01-03")
	})

	it("6. Follower Feed (Standard Join)", () => {
		const db = tupleDb()
		const layer = setup(db)

		layer.set({ type: "follow", fromId: "Me", toId: "A" })
		layer.set({ type: "follow", fromId: "Me", toId: "B" })

		layer.set({ type: "post", id: "p1", authorId: "A", createdAt: "t1", body: "A1" })
		layer.set({ type: "post", id: "p2", authorId: "B", createdAt: "t2", body: "B1" })
		layer.set({ type: "post", id: "p3", authorId: "C", createdAt: "t3", body: "C1" })

		const q = {
			match: {
				f: { from: "follow" },
				p: { from: "post", on: { authorId: "f.toId" } },
			},
			where: { "f.fromId": "Me" },
			sort: ["f.fromId", "p.createdAt", "p.id"],
		}

		const res = layer.query(q)
		assert.equal(res.length, 2)
		assert.equal(res[0]["p.id"], "p1")
		assert.equal(res[1]["p.id"], "p2")
	})

	it("7. Friends of Friends (Ordered by 'Entry into Orbit')", () => {
		const db = tupleDb()
		const layer = setup(db)

		layer.set({ type: "follow", fromId: "Me", toId: "A", createdAt: "t0" })
		layer.set({ type: "follow", fromId: "Me", toId: "B", createdAt: "t0" })

		layer.set({ type: "follow", fromId: "A", toId: "T1", createdAt: "t2" })
		layer.set({ type: "follow", fromId: "B", toId: "T2", createdAt: "t1" })

		const q = {
			match: {
				f: { from: "follow" },
				f2: { from: "follow", on: { fromId: "f.toId" } },
			},
			where: { "f.fromId": "Me" },
			reduce: {
				groupBy: ["f.fromId", "f2.toId"],
				aggregate: {
					connectionTime: { max: "f2.createdAt" },
				},
			},
			sort: ["f.fromId", "connectionTime", "f2.toId"],
		}

		const res = layer.query(q)
		assert.equal(res.length, 2)
		assert.equal(res[0]["f2.toId"], "T2")
		assert.equal(res[1]["f2.toId"], "T1")
	})

	it("should handle updates (reactivity)", () => {
		const db = tupleDb()
		const layer = setup(db)

		layer.set({ type: "user", id: "u1", name: "A", age: 10 })
		const q = {
			match: { u: { from: "user" } },
			sort: ["u.age"],
		}

		let res = layer.query(q)
		assert.equal(res.length, 1)
		assert.equal(res[0]["u.age"], 10)

		// Update
		layer.set({ type: "user", id: "u1", name: "A", age: 20 })
		res = layer.query(q)
		assert.equal(res.length, 1)
		assert.equal(res[0]["u.age"], 20)

		// Delete
		layer.delete({ type: "user", id: "u1" })
		res = layer.query(q)
		assert.equal(res.length, 0)
	})
})

describe("TupleDB Edge Cases & Complex Logic", () => {
	it("should handle changing join keys (Moving a post)", () => {
		const db = tupleDb()
		const layer = setup(db)

		layer.set({ type: "user", id: "u1", name: "A" })
		layer.set({ type: "user", id: "u2", name: "B" })
		layer.set({ type: "post", id: "p1", authorId: "u1", createdAt: "t1", body: "." })

		// Query: Count posts per user
		const q = {
			match: {
				u: { from: "user" },
				p: { from: "post", on: { authorId: "u.id" } },
			},
			reduce: {
				groupBy: ["u.id"],
				aggregate: { count: { count: "p.id" } },
			},
			sort: ["u.id"],
		}

		// Initial State
		let res = layer.query(q)
		assert.equal(res.length, 1)
		assert.equal(res[0]["u.id"], "u1")
		assert.equal(res[0].count, 1)

		// Move post to u2
		layer.set({ type: "post", id: "p1", authorId: "u2", createdAt: "t1", body: "." })

		res = layer.query(q)
		assert.equal(res.length, 1)
		assert.equal(res[0]["u.id"], "u2")
		assert.equal(res[0].count, 1)
	})

	it("should handle changing sort keys", () => {
		const db = tupleDb()
		const layer = setup(db)

		layer.set({ type: "user", id: "u1", name: "A", age: 10 })

		const q = {
			match: { u: { from: "user" } },
			sort: ["u.age", "u.id"],
		}

		let res = layer.query(q)
		assert.equal(res[0]["u.age"], 10)

		// Change age
		layer.set({ type: "user", id: "u1", name: "A", age: 99 })

		res = layer.query(q)
		assert.equal(res[0]["u.age"], 99)
	})

	it("should correctly maintain MAX aggregation with duplicates and deletions", () => {
		const db = tupleDb()
		const layer = setup(db)

		layer.set({ type: "user", id: "u1", name: "A" })

		// 3 posts: 10, 20, 20
		layer.set({ type: "post", id: "p1", authorId: "u1", createdAt: "10", body: "" })
		layer.set({ type: "post", id: "p2", authorId: "u1", createdAt: "20", body: "" })
		layer.set({ type: "post", id: "p3", authorId: "u1", createdAt: "20", body: "" })

		const q = {
			match: {
				u: { from: "user" },
				p: { from: "post", on: { authorId: "u.id" } },
			},
			reduce: {
				groupBy: ["u.id"],
				aggregate: { maxTime: { max: "p.createdAt" } },
			},
			sort: ["u.id"],
		}

		let res = layer.query(q)
		assert.equal(res[0].maxTime, "20")

		// Delete one 20 (p2)
		layer.delete({ type: "post", id: "p2" })
		res = layer.query(q)
		assert.equal(res[0].maxTime, "20") // Should still be 20 from p3

		// Delete other 20 (p3)
		layer.delete({ type: "post", id: "p3" })
		res = layer.query(q)
		assert.equal(res[0].maxTime, "10") // Should drop to 10

		// Delete 10 (p1)
		layer.delete({ type: "post", id: "p1" })
		res = layer.query(q)
		// No posts left -> User has no joined rows -> Group disappears?
		// Join is INNER JOIN logic. If no posts, no match.
		// "p" depends on "u". If "p" has no match, the tuple (u, p) doesn't exist.
		// So the group should disappear.
		assert.equal(res.length, 0)
	})

	it("should handle orphan records (Joins failing)", () => {
		const db = tupleDb()
		const layer = setup(db)

		// Post without User
		layer.set({ type: "post", id: "p1", authorId: "missing", createdAt: "t1", body: "" })

		const q = {
			match: {
				u: { from: "user" },
				p: { from: "post", on: { authorId: "u.id" } },
			},
			sort: ["u.id", "p.id"],
		}

		const res = layer.query(q)
		assert.equal(res.length, 0)

		// Create user now
		layer.set({ type: "user", id: "missing", name: "Found" })

		// Should appear now (Reactive join)
		const res2 = layer.query(q)
		assert.equal(res2.length, 1)
		assert.equal(res2[0]["u.name"], "Found")
	})
})
