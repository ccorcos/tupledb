import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { recordDb, RecordDbSchema } from "./RecordLayer"
import { tupleDb } from "./TupleDb"

type Thing = { type: "thing"; id: string; a: number; b: number }

const schema: RecordDbSchema = {
	records: {
		thing: {
			primary: ["id"],
			indexes: {
				byA: ["a", "id"],
			},
		},
	},
}

describe("RecordLayer Sort", () => {
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
			sort: ["a"]
		})

		assert.equal(res.length, 3)
		assert.equal(res[0].id, "t2") // a=5
		assert.equal(res[1].id, "t1") // a=10
		assert.equal(res[2].id, "t3") // a=20
	})

	it("should sort reverse", () => {
		// existing data t2(5), t1(10), t3(20)
		const res = layer.query({
			from: "thing",
			sort: ["a"],
			reverse: true
		})

		assert.equal(res.length, 3)
		assert.equal(res[0].id, "t3") // a=20
		assert.equal(res[1].id, "t1") // a=10
		assert.equal(res[2].id, "t2") // a=5
	})

	it("should auto-create index for new sort field", () => {
		// Sort by b (no index initially)
		const res = layer.query({
			from: "thing",
			sort: ["b"]
		})

		assert.equal(res.length, 3)
		assert.equal(res[0].id, "t1") // b=1
		assert.equal(res[1].id, "t2") // b=2
		assert.equal(res[2].id, "t3") // b=3
	})

	it("should sort by compound key", () => {
		const db = tupleDb()
		const layer = recordDb(db, schema)
		
		// Same 'a', different 'b'
		const t1: Thing = { type: "thing", id: "t1", a: 10, b: 2 }
		const t2: Thing = { type: "thing", id: "t2", a: 10, b: 1 }
		const t3: Thing = { type: "thing", id: "t3", a: 5, b: 5 }

		layer.set(t1)
		layer.set(t2)
		layer.set(t3)

		// Sort by a, then b
		const res = layer.query({
			from: "thing",
			sort: ["a", "b"]
		})

		assert.equal(res.length, 3)
		assert.equal(res[0].id, "t3") // a=5
		assert.equal(res[1].id, "t2") // a=10, b=1
		assert.equal(res[2].id, "t1") // a=10, b=2
	})
})
