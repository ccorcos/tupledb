import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { recordDb, RecordDbSchema } from "./RecordLayer"
import { tupleDb } from "./TupleDb"

type Item = { type: "item"; id: string; category: string; price: number; rating: number }

const schema: RecordDbSchema = {
	records: {
		item: {
			primary: ["id"],
			indexes: {
				byCategory: ["category", "price", "id"],
				byPrice: ["price", "id"],
			},
		},
	},
	aggregations: {
		totalPrice: {
			source: "item",
			groupBy: ["category"],
			kind: "sum",
			field: "price",
		},
		minPrice: {
			source: "item",
			groupBy: ["category"],
			kind: "min",
			field: "price",
		},
		maxPrice: {
			source: "item",
			groupBy: ["category"],
			kind: "max",
			field: "price",
		},
	},
}

describe("RecordLayer Scan & Aggregation", () => {
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
		const q = (agg: "sum" | "min" | "max") => layer.query({
			from: "item",
			groupBy: ["category"],
			aggregate: { val: agg },
			where: { category: "A" }
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

	it("should fallback to primary key scan if no index matches but primary prefix does", () => {
		const i1: Item = { type: "item", id: "i1", category: "A", price: 10, rating: 5 }
		layer.set(i1)

		const result = layer.query({ from: "item", where: { id: "i1" } })
		assert.equal(result.length, 1)
		assert.equal(result[0].id, "i1")
	})
})