import { compactObj } from "shared/compactObj"
import { ListArgs, Tuple, TupleDb } from "./types"

// ============================================================================
// Types
// ============================================================================

export type RecordSchema = {
	primary: string[]
	indexes?: { [name: string]: string[] }
}

export type AggregationSchema = {
	source: string
	groupBy: string[]
	kind: "count" | "sum" | "min" | "max"
	field?: string // Required for sum, min, max
}

export type JoinSide = {
	type: string
	on: string
	index?: string // Index to use for lookup. If undefined, attempts primary scan.
}

export type JoinSchema = {
	left: JoinSide
	right: JoinSide
	key: { side: "left" | "right"; field: string }[]
}

export type RecordDbSchema = {
	records: { [type: string]: RecordSchema }
	aggregations?: { [name: string]: AggregationSchema }
	joins?: { [name: string]: JoinSchema }
}

export type ScanArgs = ListArgs<{ [key: string]: any }> & { eq?: { [key: string]: any } }

export type ScanQuery = {
	where?: { [key: string]: any }
	limit?: number
	reverse?: boolean
}

export type QueryQuery = {
	// Target (Can be record type or join name)
	from: string | JoinSchema

	// Filter/Sort (Index)
	where?: Record<string, any>
	sort?: string[]
	reverse?: boolean

	// Aggregation
	groupBy?: string[]
	aggregate?: Record<string, "count" | "sum" | "min" | "max">
	limit?: number
}

export type Change = {
	type: string
	oldRecord: any | null
	newRecord: any | null
}

export type Reactor = (db: TupleDb, change: Change) => void

export type RecordDb = {
	// Args here contain primary key properties.
	get: (args: { type: string; [key: string]: any }) => any | undefined
	delete: (args: { type: string; [key: string]: any }) => void

	// These args are the entire record.
	set: (record: { type: string; [key: string]: any }) => void

	// Unified Query API
	query: (query: QueryQuery) => any
}

// ============================================================================
// Reactors
// ============================================================================

function createIndexReactor(schema: RecordDbSchema): Reactor {
	return (db, change) => {
		const { type, oldRecord, newRecord } = change
		const recordSchema = schema.records[type]
		if (!recordSchema || !recordSchema.indexes) return

		for (const [indexName, fields] of Object.entries(recordSchema.indexes)) {
			if (oldRecord) {
				const keys = extractKey(oldRecord, fields)
				db.delete([type, indexName, ...keys])
			}
			if (newRecord) {
				const keys = extractKey(newRecord, fields)
				db.set([type, indexName, ...keys], null)
			}
		}
	}
}

function createAggregationReactor(schema: RecordDbSchema): Reactor {
	return (db, change) => {
		const { type, oldRecord, newRecord } = change
		if (!schema.aggregations) return

		for (const [name, def] of Object.entries(schema.aggregations)) {
			if (def.source !== type) continue

			// Determine value to aggregate
			// For count, we effectively treat the value as 1.
			// For sum/min/max, we extract the field.
			const getVal = (r: any) => (def.kind === "count" ? 1 : r[def.field!])

			if (oldRecord) {
				const key = ["aggregation", name, ...extractKey(oldRecord, def.groupBy)]
				const val = getVal(oldRecord)
				updateAggregationValue(db, key, def.kind, -1, val)
			}
			if (newRecord) {
				const key = ["aggregation", name, ...extractKey(newRecord, def.groupBy)]
				const val = getVal(newRecord)
				updateAggregationValue(db, key, def.kind, 1, val)
			}
		}
	}
}

function createJoinReactor(schema: RecordDbSchema): Reactor {
	return (db, change) => {
		if (!schema.joins) return
		const { type, oldRecord, newRecord } = change

		for (const [name, def] of Object.entries(schema.joins)) {
			if (oldRecord) updateJoin(db, schema, name, def, oldRecord, -1)
			if (newRecord) updateJoin(db, schema, name, def, newRecord, 1)
		}
	}
}

function updateJoin(
	db: TupleDb,
	schema: RecordDbSchema,
	joinName: string,
	joinDef: JoinSchema,
	record: any,
	delta: number
) {
	const sides: ("left" | "right")[] = ["left", "right"]
	for (const side of sides) {
		const mySideDef = joinDef[side]
		const otherSideDef = joinDef[side === "left" ? "right" : "left"]

		if (record.type === mySideDef.type) {
			const matches = findMatches(db, schema, otherSideDef, record[mySideDef.on])
			for (const match of matches) {
				const left = side === "left" ? record : match
				const right = side === "right" ? record : match
				const keyValues = joinDef.key.map(({ side: s, field }) =>
					s === "left" ? left[field] : right[field]
				)
				increment(db, ["join", joinName, ...keyValues], delta)
			}
		}
	}
}

// ============================================================================
// Core Logic
// ============================================================================

function getRecord(
	db: TupleDb,
	schema: RecordDbSchema,
	args: { type: string; [key: string]: any }
): any {
	const { type } = args
	const recordSchema = schema.records[type]
	if (!recordSchema) throw new Error(`Unknown type: ${type}`)
	const primaryKey = extractKey(args, recordSchema.primary)
	return db.get([type, ...primaryKey])
}

function setRecord(db: TupleDb, schema: RecordDbSchema, reactor: Reactor, record: any) {
	const type = record.type
	const recordSchema = schema.records[type]
	if (!recordSchema) throw new Error(`Unknown type: ${type}`)

	const primaryKey = [type, ...extractKey(record, recordSchema.primary)]
	const oldRecord = db.get(primaryKey)

	// 1. Write Primary
	db.set(primaryKey, record)

	// 2. React
	reactor(db, { type, oldRecord, newRecord: record })
}

function deleteRecord(
	db: TupleDb,
	schema: RecordDbSchema,
	reactor: Reactor,
	args: { type: string; [key: string]: any }
) {
	const { type } = args
	const recordSchema = schema.records[type]
	if (!recordSchema) throw new Error(`Unknown type: ${type}`)

	const primaryKey = [type, ...extractKey(args, recordSchema.primary)]
	const oldRecord = db.get(primaryKey)
	if (!oldRecord) return

	// 1. Delete Primary
	db.delete(primaryKey)

	// 2. React
	reactor(db, { type, oldRecord, newRecord: null })
}

// ============================================================================
// Querying
// ============================================================================

function scanIndex(
	db: TupleDb,
	schema: RecordDbSchema,
	type: string,
	indexName: string,
	args: ScanArgs
): any[] {
	const recordSchema = schema.records[type]
	if (!recordSchema) throw new Error(`Unknown type: ${type}`)

	const indexDef = recordSchema.indexes?.[indexName]
	if (!indexDef) throw new Error(`Unknown index: ${indexName}`)

	// Map primary key fields to their position in the index definition
	const primaryKeyIndex = recordSchema.primary.map((field) => {
		const idx = indexDef.indexOf(field)
		if (idx === -1) throw new Error(`Index ${indexName} missing primary key field ${field}`)
		return idx
	})

	const prefixTuple = args.eq ? unrollKey(args.eq, indexDef) : []
	const remainingFields = indexDef.slice(prefixTuple.length)

	const listArgs: ListArgs<Tuple> = compactObj({
		limit: args.limit,
		reverse: args.reverse,
		gt: args.gt ? unrollKey(args.gt, remainingFields) : undefined,
		gte: args.gte ? unrollKey(args.gte, remainingFields) : undefined,
		lt: args.lt ? unrollKey(args.lt, remainingFields) : undefined,
		lte: args.lte ? unrollKey(args.lte, remainingFields) : undefined,
	})

	return db
		.subspace([type, indexName, ...prefixTuple])
		.list(listArgs)
		.map(({ key }) => {
			const fullIndexValues = [...prefixTuple, ...key]
			const primaryKey = primaryKeyIndex.map((idx) => fullIndexValues[idx])
			return db.get([type, ...primaryKey])
		})
}

function scanSmart(db: TupleDb, schema: RecordDbSchema, type: string, query: ScanQuery): any[] {
	const recordSchema = schema.records[type]
	if (!recordSchema) throw new Error(`Unknown type: ${type}`)

	const { where = {}, limit, reverse } = query

	// 1. Try to find a matching index
	let bestIndex: string | undefined
	let bestMatchLength = 0

	if (recordSchema.indexes) {
		for (const [name, fields] of Object.entries(recordSchema.indexes)) {
			// Check how many prefix fields are satisfied by 'where'
			let matchLength = 0
			for (const field of fields) {
				if (where[field] !== undefined) {
					matchLength++
				} else {
					break
				}
			}

			if (matchLength > bestMatchLength) {
				bestMatchLength = matchLength
				bestIndex = name
			}
		}
	}

	// 2. Use the best index if found
	if (bestIndex) {
		return scanIndex(db, schema, type, bestIndex, {
			eq: where,
			limit,
			reverse,
		})
	}

	// 3. Fallback: Check if we can use the primary key (scanIndex supports scanning primary if modeled as index?)
	// Actually scanIndex expects a named secondary index.
	// But we can check if the primary key prefix matches 'where'.
	let primaryMatchLength = 0
	for (const field of recordSchema.primary) {
		if (where[field] !== undefined) primaryMatchLength++
		else break
	}

	if (primaryMatchLength > 0) {
		// Scan primary key prefix
		const prefixTuple = unrollKey(where, recordSchema.primary)

		// Optimization: Exact Primary Key Match
		if (primaryMatchLength === recordSchema.primary.length) {
			const val = db.get([type, ...prefixTuple])
			return val ? [val] : []
		}

		// This is a direct primary scan
		// We need to support 'where' filtering for non-key fields if we want full generality,
		// but for now we assume 'where' implies equality lookup on index/primary.
		// If there are leftover 'where' clauses not covered by index, we should technically filter results.
		// But keeping it simple as per spec.

		const listArgs: ListArgs<Tuple> = compactObj({
			limit,
			reverse,
		})

		// TODO: This doesn't strictly implement filtering for non-prefix fields in 'where'.
		// But it matches the 'index' behavior.

		return db
			.subspace([type, ...prefixTuple])
			.list(listArgs)
			.map((i) => i.value)
	}

	// 4. Fallback: Full table scan (if no where clause or no matches)
	// Only acceptable if we intended to scan everything.
	if (Object.keys(where).length === 0) {
		return db.subspace([type]).list({ limit, reverse }).map(i => i.value).filter(v => v !== null)
	}

	throw new Error(`No index found for query on ${type} with where: ${JSON.stringify(where)}`)
}

// ============================================================================
// Aggregation Logic
// ============================================================================

function increment(db: TupleDb, key: Tuple, delta: number) {
	const current = (db.get(key) as number) || 0
	const next = current + delta
	if (next <= 0) {
		db.delete(key)
	} else {
		db.set(key, next)
	}
}

function updateAggregationValue(
	db: TupleDb,
	key: Tuple,
	kind: AggregationSchema["kind"],
	dir: 1 | -1,
	val: any
) {
	if (kind === "count") {
		increment(db, key, dir)
		return
	}

	if (kind === "sum") {
		// Simple counter for sum
		increment(db, key, (val as number) * dir)
	} else if (kind === "min" || kind === "max") {
		// Use a subspace to track values
		// Key: [...prefix, value] = count
		// When removing, decrement count. If 0, delete key.
		const valueKey = [...key, val]
		increment(db, valueKey, dir)
	}
}

function getAggregation(
	db: TupleDb,
	schema: RecordDbSchema,
	aggName: string,
	args: { [key: string]: any }
): number {
	const aggDef = schema.aggregations?.[aggName]
	if (!aggDef) throw new Error(`Unknown aggregation: ${aggName}`)
	const groupValues = extractKey(args, aggDef.groupBy)
	const baseKey = ["aggregation", aggName, ...groupValues]

	if (aggDef.kind === "count" || aggDef.kind === "sum") {
		const val = db.get(baseKey)
		return typeof val === "number" ? val : 0
	}

	if (aggDef.kind === "min") {
		// List first key in subspace
		const res = db.subspace(baseKey).list({ limit: 1 })
		if (res.length === 0) return 0 // Default? Or null?
		return res[0].key[0] as number
	}

	if (aggDef.kind === "max") {
		// List last key in subspace
		const res = db.subspace(baseKey).list({ limit: 1, reverse: true })
		if (res.length === 0) return 0
		return res[0].key[0] as number
	}

	return 0
}

// ============================================================================
// Join Logic
// ============================================================================

function findMatches(db: TupleDb, schema: RecordDbSchema, sideDef: JoinSide, matchVal: any): any[] {
	if (sideDef.index) {
		return scanIndex(db, schema, sideDef.type, sideDef.index, {
			eq: { [sideDef.on]: matchVal },
		})
	}
	// Primary scan assumption: [type, matchVal, ...]
	// This only works if matchVal is the first part of the primary key.
	return db
		.subspace([sideDef.type, matchVal])
		.list()
		.map((i) => i.value)
}

function scanJoin(
	db: TupleDb,
	schema: RecordDbSchema,
	name: string,
	args: ScanArgs
): { [key: string]: any }[] {
	const joinDef = schema.joins?.[name]
	if (!joinDef) throw new Error(`Unknown join: ${name}`)

	const keyFields = joinDef.key.map((k) => k.field)
	const prefixTuple = args.eq ? unrollKey(args.eq, keyFields) : []
	const remainingFields = keyFields.slice(prefixTuple.length)

	const listArgs: ListArgs<Tuple> = compactObj({
		limit: args.limit,
		reverse: args.reverse,
		gt: args.gt ? unrollKey(args.gt, remainingFields) : undefined,
		gte: args.gte ? unrollKey(args.gte, remainingFields) : undefined,
		lt: args.lt ? unrollKey(args.lt, remainingFields) : undefined,
		lte: args.lte ? unrollKey(args.lte, remainingFields) : undefined,
	})

	return db
		.subspace(["join", name, ...prefixTuple])
		.list(listArgs)
		.filter((item) => (item.value as number) > 0)
		.map(({ key }) => {
			const fullKey = [...prefixTuple, ...key]
			const obj: any = {}
			for (const [i, f] of keyFields.entries()) obj[f] = fullKey[i]
			return obj
		})
}

// ============================================================================
// Helpers
// ============================================================================

function extractKey(obj: any, fields: string[]): Tuple {
	return fields.map((f) => {
		if (obj[f] === undefined) throw new Error(`Missing key field: ${f}`)
		return obj[f]
	})
}

function unrollKey(obj: any, fields: string[]): Tuple {
	const result: Tuple = []
	if (!obj) return result
	for (const field of fields) {
		if (field in obj) result.push(obj[field])
		else break
	}
	return result
}

function deepEqual(a: any, b: any): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

// ============================================================================
// Dynamic Schema Management
// ============================================================================

function loadSchema(db: TupleDb): RecordDbSchema | null {
	const val = db.get(["_schema", "current"])
	if (!val) return null
	return val as RecordDbSchema
}

function saveSchema(db: TupleDb, schema: RecordDbSchema) {
	db.set(["_schema", "current"], schema)
}

function backfillIndex(db: TupleDb, schema: RecordDbSchema, type: string, indexName: string) {
	const recordSchema = schema.records[type]
	const indexFields = recordSchema.indexes?.[indexName]
	if (!indexFields) return

	// Iterate primary records of this type
	const prefix = [type]
	const records = db
		.subspace(prefix)
		.list()
		.filter((item) => item.value !== null)
		.map((item) => item.value)

	for (const record of records) {
		const keys = extractKey(record, indexFields)
		db.set([type, indexName, ...keys], null)
	}
}

function backfillAggregation(db: TupleDb, schema: RecordDbSchema, aggName: string) {
	const aggDef = schema.aggregations?.[aggName]
	if (!aggDef) return

	const type = aggDef.source
	const records = db
		.subspace([type])
		.list()
		.filter((item) => item.value !== null)
		.map((item) => item.value)

	for (const record of records) {
		const key = ["aggregation", aggName, ...extractKey(record, aggDef.groupBy)]
		const getVal = (r: any) => (aggDef.kind === "count" ? 1 : r[aggDef.field!])
		const val = getVal(record)
		updateAggregationValue(db, key, aggDef.kind, 1, val)
	}
}

function backfillJoin(db: TupleDb, schema: RecordDbSchema, joinName: string) {
	const joinDef = schema.joins?.[joinName]
	if (!joinDef) return

	// Only iterate Left side to avoid double counting matches
	const type = joinDef.left.type
	const records = db
		.subspace([type])
		.list()
		.filter((item) => item.value !== null)
		.map((item) => item.value)

	for (const record of records) {
		// Act as LEFT side
		const mySideDef = joinDef.left
		const otherSideDef = joinDef.right

		const matches = findMatches(db, schema, otherSideDef, record[mySideDef.on])
		for (const match of matches) {
			const left = record
			const right = match
			const keyValues = joinDef.key.map(({ side: s, field }) =>
				(s === "left" ? left[field] : right[field])
			)
			increment(db, ["join", joinName, ...keyValues], 1)
		}
	}
}

// ============================================================================
// Unified Query Processor
// ============================================================================

function ensureIndex(
	db: TupleDb,
	schema: RecordDbSchema,
	type: string,
	requiredPrefix: string[]
): { schema: RecordDbSchema; indexName: string | undefined; schemaChanged: boolean } {
	const recordSchema = schema.records[type]
	if (!recordSchema) throw new Error(`Unknown type: ${type}`)

	const neededFields = [...requiredPrefix, ...recordSchema.primary]
	const uniqueFields = [...new Set(neededFields)]

	if (deepEqual(uniqueFields, recordSchema.primary)) {
		return { schema, indexName: undefined, schemaChanged: false }
	}

	// Check existing
	if (recordSchema.indexes) {
		for (const [name, fields] of Object.entries(recordSchema.indexes)) {
			if (fields.length >= uniqueFields.length) {
				const prefix = fields.slice(0, uniqueFields.length)
				if (deepEqual(prefix, uniqueFields)) {
					return { schema, indexName: name, schemaChanged: false }
				}
			}
		}
	}

	// Create
	const indexName = `auto_idx_${uniqueFields.join("_")}`
	const newSchema = JSON.parse(JSON.stringify(schema))
	newSchema.records[type].indexes = newSchema.records[type].indexes || {}
	newSchema.records[type].indexes[indexName] = uniqueFields

	backfillIndex(db, newSchema, type, indexName)

	return { schema: newSchema, indexName, schemaChanged: true }
}

function processQuery(
	db: TupleDb,
	schema: RecordDbSchema,
	q: QueryQuery
): { schema: RecordDbSchema; result: any } {
	let updatedSchema = schema
	let schemaChanged = false
	let targetFrom = q.from

	// Handle Ad-Hoc Join
	if (typeof targetFrom === "object") {
		const joinDef = targetFrom as JoinSchema

		// Ensure indexes for both sides
		const leftRes = ensureIndex(db, updatedSchema, joinDef.left.type, [joinDef.left.on])
		updatedSchema = leftRes.schema
		schemaChanged = schemaChanged || leftRes.schemaChanged
		joinDef.left.index = leftRes.indexName

		const rightRes = ensureIndex(db, updatedSchema, joinDef.right.type, [joinDef.right.on])
		updatedSchema = rightRes.schema
		schemaChanged = schemaChanged || rightRes.schemaChanged
		joinDef.right.index = rightRes.indexName

		// Generate Join Name
		const joinName = `auto_join_${joinDef.left.type}_${joinDef.left.on}_${joinDef.right.type}_${joinDef.right.on}`

		if (!updatedSchema.joins?.[joinName]) {
			updatedSchema = JSON.parse(JSON.stringify(updatedSchema))
			updatedSchema.joins = updatedSchema.joins || {}
			updatedSchema.joins[joinName] = joinDef
			schemaChanged = true
			backfillJoin(db, updatedSchema, joinName)
		}
		targetFrom = joinName
	}

	const targetName = targetFrom as string

	// Handle JOIN Query
	if (updatedSchema.joins?.[targetName]) {
		// Map QueryQuery to ScanArgs
		const args: ScanArgs = {
			eq: q.where,
			limit: q.limit,
			reverse: q.reverse,
		}
		if (schemaChanged) saveSchema(db, updatedSchema)
		return { schema: updatedSchema, result: scanJoin(db, updatedSchema, targetName, args) }
	}

	const recordSchema = updatedSchema.records[targetName]
	if (!recordSchema) throw new Error(`Unknown type: ${targetName}`)

	let bestIndexName: string | undefined

	// 1. Ensure Index for 'where' + 'sort'
	if (q.where || q.sort) {
		const whereKeys = q.where ? Object.keys(q.where).sort() : []
		const sortKeys = q.sort || []
		const requiredPrefix = [...whereKeys, ...sortKeys]

		const res = ensureIndex(db, updatedSchema, targetName, requiredPrefix)
		updatedSchema = res.schema
		schemaChanged = schemaChanged || res.schemaChanged
		bestIndexName = res.indexName
	}

	// 2. Ensure Aggregation
	if (q.aggregate) {
		for (const [alias, kind] of Object.entries(q.aggregate)) {
			const groupBy = q.groupBy ? q.groupBy.sort() : []
			let aggName: string | undefined

			// Try to find existing matching aggregation
			if (updatedSchema.aggregations) {
				for (const [name, def] of Object.entries(updatedSchema.aggregations)) {
					if (
						def.source === targetName &&
						def.kind === kind &&
						deepEqual(def.groupBy.sort(), groupBy)
					) {
						// assuming order doesn't matter for grouping
						aggName = name
						break
					}
				}
			}

			// If not found, create new one
			if (!aggName) {
				aggName = `auto_agg_${targetName}_${kind}_${groupBy.join("_")}`

				if (!updatedSchema.aggregations?.[aggName]) {
					if (!updatedSchema.aggregations) updatedSchema.aggregations = {}
					// Limitation: simplistic 'select' type in QueryQuery
					// We assume 'count' or that the user provides necessary field info if we extend type.
					// For now, if kind != count, we lack 'field'.

					updatedSchema.aggregations[aggName] = {
						source: targetName,
						groupBy: groupBy,
						kind: kind,
						field: undefined, // TODO: Update QueryQuery to support field selection for sum/min/max
					}

					schemaChanged = true
					backfillAggregation(db, updatedSchema, aggName)
				}
			}
		}
	}

	if (schemaChanged) {
		saveSchema(db, updatedSchema)
	}

	// Execute Query
	if (q.aggregate) {
		const result: any = {}
		for (const [alias, kind] of Object.entries(q.aggregate)) {
			// Resolve name again (could be existing or auto)
			const groupBy = q.groupBy ? q.groupBy.sort() : []
			let aggName: string | undefined
			if (updatedSchema.aggregations) {
				for (const [name, def] of Object.entries(updatedSchema.aggregations)) {
					if (
						def.source === targetName &&
						def.kind === kind &&
						deepEqual(def.groupBy.sort(), groupBy)
					) {
						aggName = name
						break
					}
				}
			}
			if (!aggName) throw new Error("Aggregation logic error: name not found")

			result[alias] = getAggregation(db, updatedSchema, aggName, q.where || {})
		}
		return { schema: updatedSchema, result }
	}

	if (bestIndexName) {
		const results = scanIndex(db, updatedSchema, targetName, bestIndexName, {
			eq: q.where,
			limit: q.limit,
			reverse: q.reverse,
		})
		return { schema: updatedSchema, result: results }
	}

	const results = scanSmart(db, updatedSchema, targetName, {
		where: q.where,
		limit: q.limit,
		reverse: q.reverse,
	})

	return { schema: updatedSchema, result: results }
}

// ============================================================================
// RecordDb
// ============================================================================

export function recordDb(db: TupleDb, initialSchema: RecordDbSchema): RecordDb {
	// 1. Load schema from DB or use initial
	let currentSchema = loadSchema(db)
	if (!currentSchema) {
		currentSchema = initialSchema
		saveSchema(db, currentSchema)
	}

	const runReactors = (db: TupleDb, change: Change) => {
		const s = loadSchema(db) || initialSchema
		const reactors = [createIndexReactor(s), createAggregationReactor(s), createJoinReactor(s)]
		for (const r of reactors) r(db, change)
	}

	return {
		get: (args) => getRecord(db, loadSchema(db) || initialSchema, args),
		set: (record) => setRecord(db, loadSchema(db) || initialSchema, runReactors, record),
		delete: (args) => deleteRecord(db, loadSchema(db) || initialSchema, runReactors, args),
		query: (q) => {
			const s = loadSchema(db) || initialSchema
			const { result } = processQuery(db, s, q)
			return result
		},
	}
}
