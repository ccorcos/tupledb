import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { recordDb, Schema, Query } from "./RecordLayer"
import { tupleDb } from "../tupleDb/TupleDb"

// --- Helper for Ground Truth ---
type User = { type: "user"; id: string; name: string; age?: number }
type Product = { type: "product"; id: string; name: string; price: number }
type Order = { type: "order"; id: string; userId: string; productId: string; quantity: number; date: string }

const FUZZ_SCHEMA: Schema = {
	types: {
		user: { primary: ["id"] },
		product: { primary: ["id"] },
		order: { primary: ["id"] },
	},
	indexes: {},
}

type GroundTruthDb = {
	users: User[]
	products: Product[]
	orders: Order[]
}

function deepClone<T>(obj: T): T {
	return JSON.parse(JSON.stringify(obj))
}

function applyOperationToGroundTruth(gt: GroundTruthDb, op: { type: string; record: any; deleted?: boolean }) {
	const recordType = op.record.type
	if (recordType === "user") {
		gt.users = gt.users.filter((r) => r.id !== op.record.id)
		if (!op.deleted) gt.users.push(op.record)
	} else if (recordType === "product") {
		gt.products = gt.products.filter((r) => r.id !== op.record.id)
		if (!op.deleted) gt.products.push(op.record)
	} else if (recordType === "order") {
		gt.orders = gt.orders.filter((r) => r.id !== op.record.id)
		if (!op.deleted) gt.orders.push(op.record)
	}
}

function queryGroundTruth(gt: GroundTruthDb, query: Query): any[] {
	let results: any[] = []

	// 1. Match
	const aliases = Object.keys(query.match).sort()
	const matchDef = query.match

	function solveGroundTruth(idx: number, bound: Record<string, any>): any[] {
		if (idx >= aliases.length) {
			return [bound]
		}

		const alias = aliases[idx]
		const node = matchDef[alias]
		let candidates: any[] = []
		if (node.from === "user") candidates = gt.users
		if (node.from === "product") candidates = gt.products
		if (node.from === "order") candidates = gt.orders

		const localResults: any[] = []
		for (const candidate of candidates) {
			const newBound = { ...bound, [alias]: candidate }
			let valid = true

			// Check 'on' clause for current alias against already bound aliases
			if (node.on) {
				for (const [myField, targetPath] of Object.entries(node.on)) {
					const [targetAlias, targetField] = targetPath.split(".")
					if (newBound[targetAlias]) {
						if (candidate[myField] !== newBound[targetAlias][targetField]) {
							valid = false
							break
						}
					}
				}
			}
			if (!valid) continue

			// Check constraints from other bound aliases pointing to current alias
			for (const otherAlias in newBound) {
				if (otherAlias === alias) continue
				const otherNode = matchDef[otherAlias]
				if (otherNode?.on) {
					for (const [otherMyField, otherTargetPath] of Object.entries(otherNode.on)) {
						const [otherTargetAlias, otherTargetField] = otherTargetPath.split(".")
						if (otherTargetAlias === alias && newBound[otherTargetAlias]) {
							if (newBound[otherAlias][otherMyField] !== newBound[otherTargetAlias][otherTargetField]) {
								valid = false
								break
							}
						}
					}
				}
				if (!valid) break
			}
			if (!valid) continue

			localResults.push(...solveGroundTruth(idx + 1, newBound))
		}
		return localResults
	}

	let matchedRows = solveGroundTruth(0, {})

	// Flatten rows
	matchedRows = matchedRows.map((row) => {
		const flattened: any = {}
		for (const alias in row) {
			for (const key in row[alias]) {
				flattened[`${alias}.${key}`] = row[alias][key]
			}
		}
		return flattened
	})

	// 2. Where
	if (query.where) {
		matchedRows = matchedRows.filter((row) => {
			for (const key in query.where) {
				const constraint = query.where[key]
				const val = row[key] // Assuming flattened
				if (typeof constraint === "object" && constraint !== null) {
					if (constraint.gt !== undefined && !(val > constraint.gt)) return false
					if (constraint.lt !== undefined && !(val < constraint.lt)) return false
					if (constraint.gte !== undefined && !(val >= constraint.gte)) return false
					if (constraint.lte !== undefined && !(val <= constraint.lte)) return false
				} else {
					if (val !== constraint) return false
				}
			}
			return true
		})
	}

	// 3. Reduce
	if (query.reduce) {
		const groups = new Map<string, { __ref: number; [key: string]: any }>()
		for (const row of matchedRows) {
			const groupKeyValues = query.reduce.groupBy.map((path) => row[path])
			const groupKeyString = JSON.stringify(groupKeyValues)

			if (!groups.has(groupKeyString)) {
				const initial: { __ref: number; [key: string]: any } = { __ref: 0 }
				query.reduce.groupBy.forEach((path) => {
					initial[path] = row[path]
				})
				groups.set(groupKeyString, initial)
			}
			const groupState = groups.get(groupKeyString)!
			groupState.__ref++

			for (const alias in query.reduce.aggregate) {
				const aggDef = query.reduce.aggregate[alias]
				const op = Object.keys(aggDef)[0]
				const fieldPath = aggDef[op]
				const val = row[fieldPath]

				if (op === "count") {
					groupState[alias] = (groupState[alias] || 0) + 1
				} else if (op === "max") {
					if (groupState[alias] === undefined || val > groupState[alias]) {
						groupState[alias] = val
					}
				}
				// Min would require more complex ground truth for deletion
			}
		}
		// For now, simple ground truth doesn't simulate removal from aggregations correctly for min/max
		// This ground truth is for current state, not incremental.
		results = Array.from(groups.values()).filter(g => g.__ref > 0)
		results.forEach(r => delete r.__ref) // Clean up internal ref count
	} else {
		results = matchedRows
	}

	// 4. Sort
	if (query.sort && results.length > 0) {
		results.sort((a, b) => {
			for (const sortPath of query.sort!) {
				const valA = a[sortPath]
				const valB = b[sortPath]

				if (valA === valB) continue
				if (valA === undefined || valA === null) return -1
				if (valB === undefined || valB === null) return 1
				if (valA < valB) return -1
				if (valA > valB) return 1
			}
			return 0
		})
	}

	return results
}

// --- Fuzzer ---

const FUZZ_SCHEMA_SIMPLE: Schema = {
	types: {
		user: { primary: ["id"] },
		product: { primary: ["id"] },
		order: { primary: ["id"] },
	},
	indexes: {},
}

const FUZZ_QUERIES: Query[] = [
	{
		match: { u: { from: "user" } },
		sort: ["u.name", "u.id"],
	},
	{
		match: { p: { from: "product" } },
		sort: ["p.price", "p.id"],
	},
	{
		match: { o: { from: "order" } },
		sort: ["o.date", "o.id"],
	},
	{
		match: {
			u: { from: "user" },
			o: { from: "order", on: { userId: "u.id" } },
		},
		sort: ["u.name", "o.date", "o.id"],
	},
	{
		match: {
			u: { from: "user" },
			o: { from: "order", on: { userId: "u.id" } },
		},
		reduce: {
			groupBy: ["u.id", "u.name"],
			aggregate: {
				totalOrders: { count: "o.id" },
				lastOrderDate: { max: "o.date" },
			},
		},
		sort: ["totalOrders", "u.id"],
	},
	{
		match: {
			u: { from: "user" },
			o: { from: "order", on: { userId: "u.id" } },
			p: { from: "product", on: { id: "o.productId" } },
		},
		reduce: {
			groupBy: ["u.id", "u.name"],
			aggregate: {
				mostExpensiveItem: { max: "p.price" },
			},
		},
		sort: ["u.name"],
	},
]

function randomId(): string {
	return Math.random().toString(36).substring(2, 8)
}

function randomInt(min: number, max: number) {
	return Math.floor(Math.random() * (max - min + 1)) + min
}

describe("TupleDB Fuzz Testing (Simple)", { timeout: 60000 }, () => {
	it("should maintain consistency with ground truth under random operations", () => {
		const db = tupleDb()
		const layer = recordDb(db)
		for (const [name, def] of Object.entries(FUZZ_SCHEMA_SIMPLE.types)) {
			layer.createType(name, def)
		}

		const groundTruth: GroundTruthDb = { users: [], products: [], orders: [] }

		const numOps = 100 // Number of random operations
		const maxEntities = 5 // Max number of each entity type
		let userIds: string[] = []
		let productIds: string[] = []
		let orderIds: string[] = []

		for (let i = 0; i < numOps; i++) {
			const operationType = randomInt(1, 4) // 1: create/update user, 2: create/update product, 3: create/update order, 4: delete

			if (operationType === 1) { // User op
				const id = userIds.length < maxEntities ? randomId() : userIds[randomInt(0, userIds.length - 1)]
				const name = randomId()
				const age = randomInt(10, 80)
				const user: User = { type: "user", id, name, age }
				layer.set(user)
				applyOperationToGroundTruth(groundTruth, { type: "user", record: user })
				if (!userIds.includes(id)) userIds.push(id)
			} else if (operationType === 2) { // Product op
				const id = productIds.length < maxEntities ? randomId() : productIds[randomInt(0, productIds.length - 1)]
				const name = randomId()
				const price = randomInt(1, 100)
				const product: Product = { type: "product", id, name, price }
				layer.set(product)
				applyOperationToGroundTruth(groundTruth, { type: "product", record: product })
				if (!productIds.includes(id)) productIds.push(id)
			} else if (operationType === 3) { // Order op
				if (userIds.length > 0 && productIds.length > 0) {
					const id = orderIds.length < maxEntities ? randomId() : orderIds[randomInt(0, orderIds.length - 1)]
					const userId = userIds[randomInt(0, userIds.length - 1)]
					const productId = productIds[randomInt(0, productIds.length - 1)]
					const quantity = randomInt(1, 5)
					const date = `2023-${randomInt(1, 12).toString().padStart(2, '0')}-${randomInt(1, 28).toString().padStart(2, '0')}`
					const order: Order = { type: "order", id, userId, productId, quantity, date }
					layer.set(order)
					applyOperationToGroundTruth(groundTruth, { type: "order", record: order })
					if (!orderIds.includes(id)) orderIds.push(id)
				}
			} else if (operationType === 4) { // Delete op
				const deleteType = randomInt(1, 3)
				if (deleteType === 1 && userIds.length > 0) {
					const id = userIds[randomInt(0, userIds.length - 1)]
					layer.delete({ type: "user", id })
					applyOperationToGroundTruth(groundTruth, { type: "user", record: { id, type: "user" }, deleted: true })
					userIds = userIds.filter(x => x !== id)
				} else if (deleteType === 2 && productIds.length > 0) {
					const id = productIds[randomInt(0, productIds.length - 1)]
					layer.delete({ type: "product", id })
					applyOperationToGroundTruth(groundTruth, { type: "product", record: { id, type: "product" }, deleted: true })
					productIds = productIds.filter(x => x !== id)
				} else if (deleteType === 3 && orderIds.length > 0) {
					const id = orderIds[randomInt(0, orderIds.length - 1)]
					layer.delete({ type: "order", id })
					applyOperationToGroundTruth(groundTruth, { type: "order", record: { id, type: "order" }, deleted: true })
					orderIds = orderIds.filter(x => x !== id)
				}
			}
			
			// Run random queries and compare
			if (i % 10 === 0) { // Check every few operations
				const queryIndex = randomInt(0, FUZZ_QUERIES.length - 1)
				const query = FUZZ_QUERIES[queryIndex]

				const layerResult = layer.query(query)
				const gtResult = queryGroundTruth(groundTruth, query)
				
				// console.log("Query:", queryIndex, query)
				// console.log("Layer:", layerResult)
				// console.log("GT:", gtResult)

				assert.deepStrictEqual(layerResult, gtResult, `Mismatch for query ${queryIndex} at iteration ${i}`)
			}
		}
	})
})
