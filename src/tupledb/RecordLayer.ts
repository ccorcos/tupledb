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
// Core Record Operations
// ============================================================================

function checkMatch(record: any, where: { [key: string]: any } | undefined): boolean {
	if (!where) return true
	for (const [key, val] of Object.entries(where)) {
		if (record[key] !== val) return false
	}
	return true
}

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

	db.set(primaryKey, record)
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

	db.delete(primaryKey)
	reactor(db, { type, oldRecord, newRecord: null })
}

// ============================================================================
// Index Selection Helpers
// ============================================================================

type IndexMatch = {
	name: string
	fields: string[]
}

/**
 * Finds the best existing index (or primary key) that covers the most equality fields
 * in the query. Used for "best effort" scanning, like backfilling.
 * Does not check for sort order.
 */
function findGreedyIndex(
	schema: RecordDbSchema,
	type: string,
	where: { [key: string]: any }
): IndexMatch | undefined {
	const recordSchema = schema.records[type]
	if (!recordSchema) throw new Error(`Unknown type: ${type}`)

	let bestMatch: IndexMatch | undefined
	let bestMatchLength = 0

	// 1. Check Secondary Indexes
	if (recordSchema.indexes) {
		for (const [name, fields] of Object.entries(recordSchema.indexes)) {
			let matchLength = 0
			for (const field of fields) {
				if (where[field] !== undefined) matchLength++
				else break
			}
			if (matchLength > bestMatchLength) {
				bestMatchLength = matchLength
				bestMatch = { name, fields }
			}
		}
	}

	// 2. Check Primary Key
	let primaryMatchLength = 0
	for (const field of recordSchema.primary) {
		if (where[field] !== undefined) primaryMatchLength++
		else break
	}

	// Prefer primary if it matches equally well or better (assumed to be efficient/canonical)
	if (primaryMatchLength > 0 && primaryMatchLength >= bestMatchLength) {
		bestMatch = {
			name: "primary",
			fields: recordSchema.primary,
		}
	}

	return bestMatch
}

/**
 * Finds an index that STRICTLY matches the required prefix (canonical order).
 * Used to ensure we have a "Perfect Index" for a user query.
 */
function findStrictIndex(
	schema: RecordDbSchema,
	type: string,
	requiredPrefix: string[]
): string | undefined {
	const recordSchema = schema.records[type]
	if (!recordSchema) throw new Error(`Unknown type: ${type}`)

	if (recordSchema.indexes) {
		for (const [name, fields] of Object.entries(recordSchema.indexes)) {
			if (fields.length >= requiredPrefix.length) {
				const prefix = fields.slice(0, requiredPrefix.length)
				if (deepEqual(prefix, requiredPrefix)) {
					return name
				}
			}
		}
	}
	return undefined
}

// ============================================================================
// Low-Level Scan & Access
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

/**
 * Scans using the best currently available method.
 * Used for internal operations like backfilling where we just want the data
 * and do not want to trigger new index creation.
 */
function scanBestAvailable(
	db: TupleDb,
	schema: RecordDbSchema,
	type: string,
	query: ScanQuery
): any[] {
	const { where = {}, limit, reverse } = query
	const match = findGreedyIndex(schema, type, where)

	// 1. Use Best Index (Secondary or Primary)
	if (match) {
		// Use unrollKey to determine effective match length
		const prefixTuple = unrollKey(where, match.fields)

		// Primary Key Logic
		if (match.name === "primary") {
			return db
				.subspace([type, ...prefixTuple])
				.list({ limit, reverse })
				.map((i) => i.value)
				.filter((r) => checkMatch(r, where))
		}

		// Secondary Index Logic
		const results = scanIndex(db, schema, type, match.name, {
			eq: where,
			limit,
			reverse,
		})
		return results.filter((r) => checkMatch(r, where))
	}

	// 2. Fallback: Full Table Scan
	return db
		.subspace([type])
		.list({ limit, reverse })
		.map((i) => i.value)
		.filter((v) => v !== null && checkMatch(v, where))
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

function findMatches(db: TupleDb, schema: RecordDbSchema, sideDef: JoinSide, matchVal: any): any[] {
	// Delegate to processQuery to ensure necessary indexes are created/maintained
	const { result } = processQuery(db, schema, {
		from: sideDef.type,
		where: { [sideDef.on]: matchVal },
	})
	return result
}

// ============================================================================
// Aggregation Support
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
		increment(db, key, (val as number) * dir)
	} else if (kind === "min" || kind === "max") {
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
		const res = db.subspace(baseKey).list({ limit: 1 })
		if (res.length === 0) return 0
		return res[0].key[0] as number
	}

	if (aggDef.kind === "max") {
		const res = db.subspace(baseKey).list({ limit: 1, reverse: true })
		if (res.length === 0) return 0
		return res[0].key[0] as number
	}

	return 0
}

// ============================================================================
// Schema Management & Backfilling
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

	// Use scanBestAvailable to scan all records efficiently
	// We pass empty `where` to scan everything.
	const records = scanBestAvailable(db, schema, type, {})

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

	const type = joinDef.left.type
	const records = db
		.subspace([type])
		.list()
		.filter((item) => item.value !== null)
		.map((item) => item.value)

	for (const record of records) {
		const mySideDef = joinDef.left
		const otherSideDef = joinDef.right

		const matches = findMatches(db, schema, otherSideDef, record[mySideDef.on])
		for (const match of matches) {
			const left = record
			const right = match
			const keyValues = joinDef.key.map(({ side: s, field }) =>
				s === "left" ? left[field] : right[field]
			)
			increment(db, ["join", joinName, ...keyValues], 1)
		}
	}
}

// ============================================================================
// High-Level Query Processing
// ============================================================================

function ensurePerfectIndex(
	db: TupleDb,
	schema: RecordDbSchema,
	type: string,
	requiredPrefix: string[]
): { schema: RecordDbSchema; indexName: string | undefined; schemaChanged: boolean } {
	const recordSchema = schema.records[type]
	if (!recordSchema) throw new Error(`Unknown type: ${type}`)

	const neededFields = [...requiredPrefix, ...recordSchema.primary]
	const uniqueFields = [...new Set(neededFields)]

	// 1. Check if Primary Key is a Perfect Match
	if (deepEqual(uniqueFields, recordSchema.primary)) {
		return { schema, indexName: undefined, schemaChanged: false }
	}

	// 2. Check for existing Strict/Perfect Index
	const existingIndex = findStrictIndex(schema, type, uniqueFields)
	if (existingIndex) {
		return { schema, indexName: existingIndex, schemaChanged: false }
	}

	// 3. Create & Backfill Perfect Index
	const indexName = `auto_idx_${uniqueFields.join("_")}`
	const newSchema = JSON.parse(JSON.stringify(schema))
	newSchema.records[type].indexes = newSchema.records[type].indexes || {}
	newSchema.records[type].indexes[indexName] = uniqueFields

	backfillIndex(db, newSchema, type, indexName)

	return { schema: newSchema, indexName, schemaChanged: true }
}

function processAdHocJoin(
	db: TupleDb,
	schema: RecordDbSchema,
	joinDef: JoinSchema,
	q: QueryQuery
): { schema: RecordDbSchema; result: any } {
	let updatedSchema = schema
	let schemaChanged = false

	// 1. Ensure indexes for both sides of the join
	const leftRes = ensurePerfectIndex(db, updatedSchema, joinDef.left.type, [joinDef.left.on])
	updatedSchema = leftRes.schema
	schemaChanged = schemaChanged || leftRes.schemaChanged

	const rightRes = ensurePerfectIndex(db, updatedSchema, joinDef.right.type, [joinDef.right.on])
	updatedSchema = rightRes.schema
	schemaChanged = schemaChanged || rightRes.schemaChanged

	// 2. Generate and Register Join Schema
	const joinName = `auto_join_${joinDef.left.type}_${joinDef.left.on}_${joinDef.right.type}_${joinDef.right.on}`

	if (!updatedSchema.joins?.[joinName]) {
		updatedSchema = JSON.parse(JSON.stringify(updatedSchema))
		updatedSchema.joins = updatedSchema.joins || {}
		updatedSchema.joins[joinName] = joinDef
		schemaChanged = true
		backfillJoin(db, updatedSchema, joinName)
	}

	if (schemaChanged) saveSchema(db, updatedSchema)

	// 3. Execute
	return processJoinQuery(db, updatedSchema, joinName, q)
}

function processJoinQuery(
	db: TupleDb,
	schema: RecordDbSchema,
	joinName: string,
	q: QueryQuery
): { schema: RecordDbSchema; result: any } {
	const args: ScanArgs = {
		eq: q.where,
		limit: q.limit,
		reverse: q.reverse,
	}
	return { schema, result: scanJoin(db, schema, joinName, args) }
}

function ensureAggregation(
	db: TupleDb,
	schema: RecordDbSchema,
	targetName: string,
	groupBy: string[],
	kind: AggregationSchema["kind"]
): { schema: RecordDbSchema; aggName: string; schemaChanged: boolean } {
	let aggName: string | undefined

	// Check existing
	if (schema.aggregations) {
		for (const [name, def] of Object.entries(schema.aggregations)) {
			if (
				def.source === targetName &&
				def.kind === kind &&
				deepEqual(def.groupBy.sort(), groupBy)
			) {
				return { schema, aggName: name, schemaChanged: false }
			}
		}
	}

	// Create New
	aggName = `auto_agg_${targetName}_${kind}_${groupBy.join("_")}`
	const newSchema = JSON.parse(JSON.stringify(schema))
	newSchema.aggregations = newSchema.aggregations || {}

	newSchema.aggregations[aggName] = {
		source: targetName,
		groupBy: groupBy,
		kind: kind,
		field: undefined, // Limitation: simplistic auto-agg currently
	}

	backfillAggregation(db, newSchema, aggName)

	return { schema: newSchema, aggName, schemaChanged: true }
}

function processAggregationQuery(
	db: TupleDb,
	schema: RecordDbSchema,
	targetName: string,
	q: QueryQuery
): { schema: RecordDbSchema; result: any } {
	if (!q.aggregate) throw new Error("Not an aggregation query")

	let updatedSchema = schema
	let schemaChanged = false

	// 1. Ensure all requested aggregations exist
	for (const [alias, kind] of Object.entries(q.aggregate)) {
		const groupBy = q.groupBy ? q.groupBy.sort() : []
		const res = ensureAggregation(db, updatedSchema, targetName, groupBy, kind)
		updatedSchema = res.schema
		schemaChanged = schemaChanged || res.schemaChanged
	}

	if (schemaChanged) saveSchema(db, updatedSchema)

	// 2. Fetch results
	const result: any = {}
	for (const [alias, kind] of Object.entries(q.aggregate)) {
		const groupBy = q.groupBy ? q.groupBy.sort() : []

		let aggName: string | undefined
		for (const [name, def] of Object.entries(updatedSchema.aggregations!)) {
			if (
				def.source === targetName &&
				def.kind === kind &&
				deepEqual(def.groupBy.sort(), groupBy)
			) {
				aggName = name
				break
			}
		}

		if (!aggName) throw new Error("Aggregation missing after creation")
		result[alias] = getAggregation(db, updatedSchema, aggName, q.where || {})
	}

	return { schema: updatedSchema, result }
}

function processRecordQuery(
	db: TupleDb,
	schema: RecordDbSchema,
	targetName: string,
	q: QueryQuery
): { schema: RecordDbSchema; result: any } {
	let updatedSchema = schema
	let schemaChanged = false
	let perfectIndexName: string | undefined

	const recordSchema = updatedSchema.records[targetName]
	if (!recordSchema) throw new Error(`Unknown type: ${targetName}`)

	// 1. Ensure Perfect Index
	const whereKeys = q.where ? Object.keys(q.where).sort() : []
	const sortKeys = q.sort || []
	const requiredPrefix = [...whereKeys, ...sortKeys]

	const res = ensurePerfectIndex(db, updatedSchema, targetName, requiredPrefix)
	updatedSchema = res.schema
	schemaChanged = schemaChanged || res.schemaChanged
	perfectIndexName = res.indexName

	if (schemaChanged) saveSchema(db, updatedSchema)

	// 2. Execute Scan (Trusted - No checkMatch needed)
	if (perfectIndexName) {
		const results = scanIndex(db, updatedSchema, targetName, perfectIndexName, {
			eq: q.where,
			limit: q.limit,
			reverse: q.reverse,
		})
		return { schema: updatedSchema, result: results }
	}

	// Fallback to Primary Key Scan (Perfect Match)
	// ensurePerfectIndex returns undefined ONLY if Primary Key is perfect match.
	const prefixTuple = q.where ? unrollKey(q.where, recordSchema.primary) : []
	const results = db
		.subspace([targetName, ...prefixTuple])
		.list({ limit: q.limit, reverse: q.reverse })
		.map((i) => i.value)
		.filter((r) => r !== null) // No checkMatch required if primary key matches perfectly

	return { schema: updatedSchema, result: results }
}

function processQuery(
	db: TupleDb,
	schema: RecordDbSchema,
	q: QueryQuery
): { schema: RecordDbSchema; result: any } {
	// Dispatcher

	// 1. Ad-Hoc Join
	if (typeof q.from === "object") {
		return processAdHocJoin(db, schema, q.from as JoinSchema, q)
	}

	const targetName = q.from as string

	// 2. Named Join
	if (schema.joins?.[targetName]) {
		return processJoinQuery(db, schema, targetName, q)
	}

	// 3. Aggregation
	if (q.aggregate) {
		return processAggregationQuery(db, schema, targetName, q)
	}

	// 4. Standard Record Query
	return processRecordQuery(db, schema, targetName, q)
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
// RecordDb Factory
// ============================================================================

export function recordDb(db: TupleDb, initialSchema: RecordDbSchema): RecordDb {
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
