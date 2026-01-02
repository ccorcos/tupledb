import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { codec } from "./Codec"
import { OkvCache, writeToInsert } from "./OkvCache"
import { TupleCache } from "./TupleCache"

describe("TupleCache", () => {
	it("subspaces don't poison the global cache", () => {
		const okv = new OkvCache(codec.compare)
		const cacheA = new TupleCache(okv, ["a"])
		const cacheB = new TupleCache(okv, ["b"])

		// Insert into A without bounds (should be scoped to A)
		// If bug exists, this will tell OkvCache we have EVERYTHING.
		cacheA.insert([{ args: {}, result: [{ key: ["1"], value: 1 }] }])

		// Verify A has it
		// TupleCache.list uses EncodeSubspaceListArgs, so it queries OkvCache with prefix "a".
		// OkvCache should say HIT.
		assert.deepEqual(cacheA.list({}), { hit: [{ key: ["1"], value: 1 }] })

		// Verify B is missed (should be miss, not empty hit)
		// TupleCache.list queries OkvCache with prefix "b".
		// If OkvCache thinks we have EVERYTHING, it will see we have nothing for "b", and return HIT [].
		// But we expect MISS.
		const resB = cacheB.list({})
		assert.deepEqual(resB, { miss: true })
	})

	it("subscribe scoped to subspace", () => {
		const okv = new OkvCache(codec.compare)
		const cacheA = new TupleCache(okv, ["a"])
		const cacheB = new TupleCache(okv, ["b"])

		let calledA = 0
		cacheA.subscribe({}, () => {
			calledA++
		})

		// Emit on B
		// We simulate a write to B via okv directly or via cacheB
		// If bug exists, cacheA subscribed to EVERYTHING, so it will hear about B.
		cacheB.insert(writeToInsert({ set: [{ key: ["1"], value: 1 }] }))

		// A should NOT be called because it's subscribed to "a" subspace
		assert.equal(calledA, 0)

		// Emit on A
		cacheA.insert(writeToInsert({ set: [{ key: ["1"], value: 1 }] }))
		assert.equal(calledA, 1)
	})
})
