import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { JoinSchema, recordDb, Schema, AggregationOp } from "./RecordLayer"
import { tupleDb } from "./TupleDb"

// Define the types
type User = { type: "user"; id: string; name: string; bio: string }
type Post = { type: "post"; id: string; authorId: string; datetime: string; body: string }
type Follow = { type: "follow"; fromId: string; toId: string; datetime: string }

const schema: Schema = {
	types: {
		user: { primary: ["id"] },
		post: { primary: ["id"] },
		follow: { primary: ["fromId", "toId"] },
		notification: { primary: ["userId", "postId"] },
	},
	indexes: {},
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

		// Find generated index name
        const indexes = db.subspace(["_schema", "indexes"]).list().map(i => i.key[0] as string)
        const indexName = indexes.find(n => n.startsWith("auto_idx_user_"))
        assert.ok(indexName)

		// Check index via tupleDb directly
		// Key: [type, indexName, ...sortKeys, ...pk]
		const indexKey = ["user", indexName!, "Chet", "u1"]
		assert.equal(db.get(indexKey), null)

		// Update user
		const updated: User = { ...user, name: "Chester" }
		layer.set(updated)

		// Old index should be gone
		assert.equal(db.get(indexKey), undefined)

		// New index key [..., "Chester", "u1"]
        // Since the index is conditional (where name="Chet"), "Chester" is filtered out.
		const newIndexKey = ["user", indexName!, "Chester", "u1"]
		assert.equal(db.get(newIndexKey), undefined)
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
        const indexes = db.subspace(["_schema", "indexes"]).list().map(i => i.key[0] as string)
		assert.ok(indexes.some(n => n.startsWith("auto_idx_user_")))
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
				aggregate: { count: { kind: "count" } },
				where: { authorId: "u1" },
			}).count,
			0
		)

		layer.set(post1)
		assert.equal(
			layer.query({
				from: "post",
				groupBy: ["authorId"],
				aggregate: { count: { kind: "count" } },
				where: { authorId: "u1" },
			}).count,
			1
		)

		layer.set(post2)
		assert.equal(
			layer.query({
				from: "post",
				groupBy: ["authorId"],
				aggregate: { count: { kind: "count" } },
				where: { authorId: "u1" },
			}).count,
			2
		)

		assert.equal(
			layer.query({
				from: "post",
				groupBy: ["authorId"],
				aggregate: { count: { kind: "count" } },
				where: { authorId: "u2" },
			}).count,
			0
		)

		layer.set(post3)
		assert.equal(
			layer.query({
				from: "post",
				groupBy: ["authorId"],
				aggregate: { count: { kind: "count" } },
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
				aggregate: { count: { kind: "count" } },
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
				aggregate: { count: { kind: "count" } },
				where: { authorId: "u1" },
			}).count,
			0
		)
		assert.equal(
			layer.query({
				from: "post",
				groupBy: ["authorId"],
				aggregate: { count: { kind: "count" } },
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
		const joinName = `auto_join_follow_toId_follow_fromId`
		assert.ok(db.get(["_schema", "indexes", joinName]))
		
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
		layer.set({ type: "follow", fromId: "uMe", toId: "uA", datetime: "t0" })
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

		// Timeline Feed
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

		// Check ordering
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
		assert.equal(timeline2[0].id, "pA1")
		assert.equal(timeline2[1].id, "pA2")

		// Identity Feed
		const identityFeed = layer.query({
			from: {
				left: { type: "follow", on: "fromId" },
				right: { type: "post", on: "authorId" },
				key: [
					{ side: "left", field: "toId" },
					{ side: "right", field: "datetime" },
					{ side: "right", field: "id" },
				],
			},
			where: { toId: "uMe" },
		})

		assert.equal(identityFeed.length, 1)
		assert.equal(identityFeed[0].id, "pB1")
	})
})

describe("RecordLayer Dynamic Query", () => {
	type Item = { type: "item"; id: string; name: string; category: string; price: number }

	const initialSchema: Schema = {
		types: {
			item: { primary: ["id"] },
		},
		indexes: {}
	}

	it("should automatically create an index for a filtered query", () => {
		const db = tupleDb()
		const layer = recordDb(db, initialSchema)

		const i1: Item = { type: "item", id: "i1", name: "Apple", category: "Fruit", price: 1 }
		const i2: Item = { type: "item", id: "i2", name: "Banana", category: "Fruit", price: 2 }
		const i3: Item = { type: "item", id: "i3", name: "Carrot", category: "Veg", price: 1 }

		layer.set(i1)
		layer.set(i2)
		layer.set(i3)

		// Query requiring index on 'category'
		const fruits = layer.query({
			from: "item",
			where: { category: "Fruit" },
		})

		assert.equal(fruits.length, 2)
		assert.equal(fruits[0].name, "Apple")
		assert.equal(fruits[1].name, "Banana")

		// Check if schema was updated
        const indexes = db.subspace(["_schema", "indexes"]).list().map(i => i.key[0] as string)
		assert.ok(indexes.some(n => n.startsWith("auto_idx_item_")))

		// Add a new item and ensure index is maintained
		const i4: Item = { type: "item", id: "i4", name: "Date", category: "Fruit", price: 3 }
		layer.set(i4)

		const fruits2 = layer.query({
			from: "item",
			where: { category: "Fruit" },
		})
		assert.equal(fruits2.length, 3)
	})

	it("should use the same index for {a, b} and {b, a} due to key sorting", () => {
		type TestRec = { type: "test"; id: string; a: number; b: number }
		const db = tupleDb()
		const layer = recordDb(db, { types: { test: { primary: ["id"] } }, indexes: {} })

		const r1: TestRec = { type: "test", id: "1", a: 1, b: 2 }
		layer.set(r1)

		// 1. Query with {a, b}
		layer.query({
			from: "test",
			where: { b: 2, a: 1 },
		})

		// 2. Query with {b, a}
		layer.query({
			from: "test",
			where: { a: 1, b: 2 },
		})

        const indexes = db.subspace(["_schema", "indexes"]).list().map(i => i.key[0] as string)
        const testIndexes = indexes.filter(n => n.startsWith("auto_idx_test_"))
        
        // Should trigger only one index if they result in same structure
        assert.equal(testIndexes.length, 1)
	})

	it("should reuse index for {where: {a, b}} if {sort: [b, a]} created one", () => {
		type TestRec = { type: "test"; id: string; a: number; b: number }
		const db = tupleDb()
		const layer = recordDb(db, { types: { test: { primary: ["id"] } }, indexes: {} })

		const r1: TestRec = { type: "test", id: "1", a: 1, b: 2 }
		layer.set(r1)

		// 1. Query with {sort: [b, a]}
		// This creates index for b, a
		layer.query({
			from: "test",
			sort: ["b", "a"],
		})

		// 2. Query with {where: {a, b}}
		// Should reuse the existing index
		const res = layer.query({
			from: "test",
			where: { a: 1, b: 2 },
		})
		assert.equal(res.length, 1)

        const indexes = db.subspace(["_schema", "indexes"]).list().map(i => i.key[0] as string)
        const testIndexes = indexes.filter(n => n.startsWith("auto_idx_test_"))
		// Should still be 1 index
		assert.equal(testIndexes.length, 1)
	})

	it("should automatically create an aggregation view", () => {
		const db = tupleDb()
		const layer = recordDb(db, initialSchema)

		const i1: Item = { type: "item", id: "i1", name: "A", category: "Fruit", price: 10 }
		const i2: Item = { type: "item", id: "i2", name: "B", category: "Fruit", price: 20 }
		const i3: Item = { type: "item", id: "i3", name: "C", category: "Veg", price: 5 }

		layer.set(i1)
		layer.set(i2)
		layer.set(i3)

		// Query count by category
		const result = layer.query({
			from: "item",
			groupBy: ["category"],
			aggregate: { count: { kind: "count" } },
			where: { category: "Fruit" },
		})

		assert.equal(result.count, 2)

		// Check schema
		const indexes = db.subspace(["_schema", "indexes"]).list().map(i => i.key[0] as string)
        assert.ok(indexes.some(n => n.startsWith("auto_agg_item_")))

		// Add item, check maintenance
		layer.set({ type: "item", id: "i4", name: "D", category: "Fruit", price: 5 })
		const result2 = layer.query({
			from: "item",
			groupBy: ["category"],
			aggregate: { count: { kind: "count" } },
			where: { category: "Fruit" },
		})
		assert.equal(result2.count, 3)
	})
})

describe("RecordLayer Scan & Aggregation", () => {
	type Item = { type: "item"; id: string; category: string; price: number; rating: number }

	const schema: Schema = {
		types: {
			item: { primary: ["id"] }
		},
		indexes: {
			byCategory: { from: "item", sort: ["category", "price"] },
			byPrice: { from: "item", sort: ["price"] },
			totalPrice: {
				from: "item",
				groupBy: ["category"],
				aggregate: { val: { kind: "sum", field: "price" } }
			},
			minPrice: {
				from: "item",
				groupBy: ["category"],
				aggregate: { val: { kind: "min", field: "price" } }
			},
			maxPrice: {
				from: "item",
				groupBy: ["category"],
				aggregate: { val: { kind: "max", field: "price" } }
			}
		},
	}

	const db = tupleDb()
	const layer = recordDb(db, schema)

	it("should select the best index for scanning", () => {
		const i1: Item = { type: "item", id: "i1", category: "A", price: 10, rating: 5 }
		const i2: Item = { type: "item", id: "i2", category: "A", price: 20, rating: 4 }
		const i3: Item = { type: "item", id: "i3", category: "B", price: 15, rating: 3 }

		layer.set(i1)
		layer.set(i2)
		layer.set(i3)

		// Query by category: Should use byCategory
		const catA = layer.query({ from: "item", where: { category: "A" } })
		assert.equal(catA.length, 2)
		assert.equal(catA[0].id, "i1")
		assert.equal(catA[1].id, "i2")

		// Query by price: Should use byPrice
		const price15 = layer.query({ from: "item", where: { price: 15 } })
		assert.equal(price15.length, 1)
		assert.equal(price15[0].id, "i3")
	})

	it("should aggregate sum, min, max", () => {
		const db = tupleDb()
		const layer = recordDb(db, schema)
		const i1: Item = { type: "item", id: "i1", category: "A", price: 10, rating: 5 }
		const i2: Item = { type: "item", id: "i2", category: "A", price: 20, rating: 4 }
		const i3: Item = { type: "item", id: "i3", category: "A", price: 5, rating: 3 }

		layer.set(i1) // A: sum=10, min=10, max=10
		const q = (agg: "sum" | "min" | "max") =>
			layer.query({
				from: "item",
				groupBy: ["category"],
				aggregate: { val: { kind: agg, field: "price" } },
				where: { category: "A" },
			}).val

		assert.equal(q("sum"), 10)
		assert.equal(q("min"), 10)
		assert.equal(q("max"), 10)

		layer.set(i2) // A: sum=30, min=10, max=20
		assert.equal(q("sum"), 30)
		assert.equal(q("min"), 10)
		assert.equal(q("max"), 20)

		layer.set(i3) // A: sum=35, min=5, max=20
		assert.equal(q("sum"), 35)
		assert.equal(q("min"), 5)
		assert.equal(q("max"), 20)

		layer.delete({ type: "item", id: "i2" }) // remove 20. sum=15, min=5, max=10
		assert.equal(q("sum"), 15)
		assert.equal(q("min"), 5)
		assert.equal(q("max"), 10)
	})
})

describe("RecordLayer Sort", () => {
	type Thing = { type: "thing"; id: string; a: number; b: number }

	const schema: Schema = {
		types: {
			thing: { primary: ["id"] }
		},
		indexes: {
			byA: { from: "thing", sort: ["a"] }
		}
	}

	const db = tupleDb()
	const layer = recordDb(db, schema)

	it("should sort by existing index", () => {
		const t1: Thing = { type: "thing", id: "t1", a: 10, b: 1 }
		const t2: Thing = { type: "thing", id: "t2", a: 5, b: 2 }
		const t3: Thing = { type: "thing", id: "t3", a: 20, b: 3 }

		layer.set(t1)
		layer.set(t2)
		layer.set(t3)

		// Sort by a
		const res = layer.query({
			from: "thing",
			sort: ["a"],
		})

		assert.equal(res.length, 3)
		assert.equal(res[0].id, "t2") // a=5
		assert.equal(res[1].id, "t1") // a=10
		assert.equal(res[2].id, "t3") // a=20
	})
})