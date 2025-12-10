import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { recordDb, RecordDbSchema } from "./RecordLayer"
import { tupleDb } from "./TupleDb"

type Item = { type: "item"; id: string; name: string; category: string; price: number }

const initialSchema: RecordDbSchema = {
	records: {
		item: { primary: ["id"] },
	},
}

describe("RecordLayer Dynamic Query", () => {
	it("should automatically create an index for a filtered query", () => {
		const db = tupleDb()
		const layer = recordDb(db, initialSchema)

		const i1: Item = { type: "item", id: "i1", name: "Apple", category: "Fruit", price: 1 }
		const i2: Item = { type: "item", id: "i2", name: "Banana", category: "Fruit", price: 2 }
		const i3: Item = { type: "item", id: "i3", name: "Carrot", category: "Veg", price: 1 }

		layer.set(i1)
		layer.set(i2)
		layer.set(i3)

		// Initial state: no indexes
		const schemaBefore = db.get(["_schema", "current"]) as RecordDbSchema
		assert.deepEqual(schemaBefore, initialSchema)

		// Query requiring index on 'category'
		const fruits = layer.query({
			from: "item",
			where: { category: "Fruit" },
		})

		assert.equal(fruits.length, 2)
		assert.equal(fruits[0].name, "Apple")
		assert.equal(fruits[1].name, "Banana")

		// Check if schema was updated
		const schemaAfter = db.get(["_schema", "current"]) as RecordDbSchema
		assert.ok(schemaAfter.records.item.indexes)
		const indexNames = Object.keys(schemaAfter.records.item.indexes || {})
		assert.ok(indexNames.some((name) => name.includes("category")))

		// Add a new item and ensure index is maintained
		const i4: Item = { type: "item", id: "i4", name: "Date", category: "Fruit", price: 3 }
		layer.set(i4)

		const fruits2 = layer.query({
			from: "item",
			where: { category: "Fruit" },
		})
		assert.equal(fruits2.length, 3)
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
			aggregate: { count: "count" },
			where: { category: "Fruit" },
		})

		// Result should be { count: 2 }
		assert.equal(result.count, 2)

		// Check schema
		const schema = db.get(["_schema", "current"]) as RecordDbSchema
		assert.ok(schema.aggregations)
		const aggNames = Object.keys(schema.aggregations)
		assert.ok(aggNames.some((n) => n.includes("count") && n.includes("category")))

		// Add item, check maintenance
		layer.set({ type: "item", id: "i4", name: "D", category: "Fruit", price: 5 })
		const result2 = layer.query({
			from: "item",
			groupBy: ["category"],
			aggregate: { count: "count" },
			where: { category: "Fruit" },
		})
		assert.equal(result2.count, 3)
	})
})
