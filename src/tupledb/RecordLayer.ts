import { cloneDeep, isEqual, union } from "lodash-es"
import { compactObj } from "shared/compactObj"
import { ListArgs, Tuple, TupleDb } from "./types"

// ============================================================================
// Types
// ============================================================================

export type RecordSchema = {
	primary: string[]
	[index: string]: string[]
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
// Strategy Implementations
// ============================================================================

// Re-implementing the specific logic objects to capture the full context (Name + Def)

function updateRecordIndex(
	db: TupleDb,
	type: string,
	indexName: string,
	fields: string[],
	record: any,
	delta: number
) {
	const keys = extractKey(record, fields)
	const dbKey = [type, indexName, ...keys]
	if (delta === 1) db.set(dbKey, null)
	else db.delete(dbKey)
}

function updateAggregationIndex(
	db: TupleDb,
	name: string,
	def: AggregationSchema,
	record: any,
	delta: number
) {
	const groupKey = ["aggregation", name, ...extractKey(record, def.groupBy)]
	const val = def.kind === "count" ? 1 : record[def.field!]

	if (def.kind === "count") {
		increment(db, groupKey, delta)
	} else if (def.kind === "sum") {
		increment(db, groupKey, (val as number) * delta)
	} else if (def.kind === "min" || def.kind === "max") {
		const valueKey = [...groupKey, val]
		increment(db, valueKey, delta)
	}
}

function updateJoinIndex(
	db: TupleDb,
	schema: RecordDbSchema,
	joinName: string,
	def: JoinSchema,
	record: any,
	delta: number
) {
	// Joins are bidirectional. We check which side 'record' belongs to.
	const sides: ("left" | "right")[] = ["left", "right"]
	for (const side of sides) {
		const mySideDef = def[side]
		const otherSideDef = def[side === "left" ? "right" : "left"]

		if (record.type === mySideDef.type) {
			// 1. Find matches on the other side
			const matches = findMatches(db, schema, otherSideDef, record[mySideDef.on])

			// 2. For each match, update the join table
			for (const match of matches) {
				const left = side === "left" ? record : match
				const right = side === "right" ? record : match
				const keyValues = def.key.map(({ side: s, field }) =>
					s === "left" ? left[field] : right[field]
				)
				increment(db, ["join", joinName, ...keyValues], delta)
			}
		}
	}
}

// ============================================================================
// Core Update Loop (The "Write" Path)
// ============================================================================

function updateIndexes(db: TupleDb, schema: RecordDbSchema, change: Change) {
	const { type, oldRecord, newRecord } = change

	// Helper to apply +/- logic
	const update = (fn: (r: any, d: number) => void) => {
		if (oldRecord) fn(oldRecord, -1)
		if (newRecord) fn(newRecord, 1)
	}

	// 1. Indexes
	const recordSchema = schema.records[type]
	if (recordSchema) {
		for (const [name, fields] of Object.entries(recordSchema)) {
			if (name === "primary") continue
			update((r, d) => updateRecordIndex(db, type, name, fields, r, d))
		}
	}

	// 2. Aggregations
	if (schema.aggregations) {
		for (const [name, def] of Object.entries(schema.aggregations)) {
			if (def.source === type) {
				update((r, d) => updateAggregationIndex(db, name, def, r, d))
			}
		}
	}

	// 3. Joins
	if (schema.joins) {
		for (const [name, def] of Object.entries(schema.joins)) {
			// Join logic handles type checking internally
			update((r, d) => updateJoinIndex(db, schema, name, def, r, d))
		}
	}
}

// ============================================================================
// Low-Level Helpers (Scan, Keys, Math)
// ============================================================================

function backfillRecordIndex(db: TupleDb, schema: RecordDbSchema, type: string, indexName: string) {
	const fields = schema.records[type][indexName]
	if (!fields) return
	const records = db
		.subspace([type, "primary"])
		.list()
		.map((i) => i.value)
	for (const r of records) {
		updateRecordIndex(db, type, indexName, fields, r, 1)
	}
}

function backfillAggregationIndex(db: TupleDb, schema: RecordDbSchema, name: string) {
	const def = schema.aggregations?.[name]
	if (!def) return
	const records = db
		.subspace([def.source, "primary"])
		.list()
		.map((i) => i.value)
	for (const r of records) {
		updateAggregationIndex(db, name, def, r, 1)
	}
}

function backfillJoinIndex(db: TupleDb, schema: RecordDbSchema, name: string) {
	const def = schema.joins?.[name]
	if (!def) return

	// For backfill, we iterate one side (Left) and find matches on the other (Right).
	// This avoids double-counting that would occur if we used the bidirectional JoinLogic.update
	// on every record (especially for self-joins).
	const records = db
		.subspace([def.left.type, "primary"])
		.list()
		.map((i) => i.value)
	for (const leftRecord of records) {
		const matches = findMatches(db, schema, def.right, leftRecord[def.left.on])
		for (const rightRecord of matches) {
			const keyValues = def.key.map(({ side: s, field }) =>
				s === "left" ? leftRecord[field] : rightRecord[field]
			)
			increment(db, ["join", name, ...keyValues], 1)
		}
	}
}

// ============================================================================
// Query Planning & Execution (The "Read" Path)
// ============================================================================

function processQuery(
	db: TupleDb,
	schema: RecordDbSchema,
	q: QueryQuery
): { schema: RecordDbSchema; result: any } {
	// 1. Ad-Hoc Join
	if (typeof q.from === "object") {
		return processAdHocJoin(db, schema, q.from as JoinSchema, q)
	}

	const target = q.from as string

	// 2. Named Join
	if (schema.joins?.[target]) {
		return processJoinQuery(db, schema, target, q)
	}

	// 3. Aggregation
	if (q.aggregate) {
		return processAggregationQuery(db, schema, target, q)
	}

	// 4. Record Query
	return processRecordQuery(db, schema, target, q)
}

// --- Query Processors ---

function processAdHocJoin(db: TupleDb, schema: RecordDbSchema, joinDef: JoinSchema, q: QueryQuery) {
	let updatedSchema = schema

	// Ensure indexes on both sides (required for efficient join updates)
	const left = ensureIndex(db, updatedSchema, joinDef.left.type, [joinDef.left.on], [])
	updatedSchema = left.schema

	const right = ensureIndex(db, updatedSchema, joinDef.right.type, [joinDef.right.on], [])
	updatedSchema = right.schema

	// Ensure the Join View itself
	const joinName = `auto_join_${joinDef.left.type}_${joinDef.left.on}_${joinDef.right.type}_${joinDef.right.on}`

	if (!updatedSchema.joins?.[joinName]) {
		const newSchema = cloneDeep(updatedSchema)
		newSchema.joins = newSchema.joins || {}
		newSchema.joins[joinName] = joinDef
		backfillJoinIndex(db, newSchema, joinName)
		saveSchema(db, newSchema)
		updatedSchema = newSchema
	}

	return processJoinQuery(db, updatedSchema, joinName, q)
}

function processJoinQuery(db: TupleDb, schema: RecordDbSchema, joinName: string, q: QueryQuery) {
	const def = schema.joins![joinName]
	const keyFields = def.key.map((k) => k.field)

	// Prepare scan args
	const prefixTuple = q.where ? unrollKey(q.where, keyFields) : []
	const listArgs = makeListArgs(
		{ eq: q.where, limit: q.limit, reverse: q.reverse, ...q.where }, // mixing args for simplicity
		prefixTuple.length,
		keyFields,
		q
	)

	const results = db
		.subspace(["join", joinName, ...prefixTuple])
		.list(listArgs)
		.filter((item) => (item.value as number) > 0)
		.map(({ key }) => {
			const fullKey = [...prefixTuple, ...key]
			const obj: any = {}
			for (const [i, f] of keyFields.entries()) obj[f] = fullKey[i]
			return obj
		})

	return { schema, result: results }
}

function processAggregationQuery(db: TupleDb, schema: RecordDbSchema, type: string, q: QueryQuery) {
	let updatedSchema = schema

	// Ensure all requested aggregations exist
	for (const [alias, kind] of Object.entries(q.aggregate!)) {
		const groupBy = q.groupBy ? q.groupBy.sort() : []

		// Find existing
		let existing = false
		if (updatedSchema.aggregations) {
			for (const [_, def] of Object.entries(updatedSchema.aggregations)) {
				if (def.source === type && def.kind === kind && isEqual(def.groupBy.sort(), groupBy)) {
					existing = true
					break
				}
			}
		}

		if (!existing) {
			const aggName = `auto_agg_${type}_${kind}_${groupBy.join("_")}`

			const newSchema = cloneDeep(updatedSchema)
			newSchema.aggregations = newSchema.aggregations || {}
			newSchema.aggregations[aggName] = { source: type, groupBy, kind, field: undefined }
			backfillAggregationIndex(db, newSchema, aggName)
			saveSchema(db, newSchema)
			updatedSchema = newSchema
		}
	}

	// Execute
	const result: any = {}
	for (const [alias, kind] of Object.entries(q.aggregate!)) {
		const groupBy = q.groupBy ? q.groupBy.sort() : []
		let name: string | undefined
		for (const [n, def] of Object.entries(updatedSchema.aggregations!)) {
			if (def.source === type && def.kind === kind && isEqual(def.groupBy.sort(), groupBy)) {
				name = n
				break
			}
		}

		const aggDef = updatedSchema.aggregations![name!]
		const groupKey = ["aggregation", name, ...extractKey(q.where || {}, aggDef.groupBy)]

		if (aggDef.kind === "count" || aggDef.kind === "sum") {
			result[alias] = (db.get(groupKey) as number) || 0
		} else {
			// Min/Max stored as keys in subspace
			const listOpts = { limit: 1, reverse: aggDef.kind === "max" }
			const res = db.subspace(groupKey).list(listOpts)
			result[alias] = res.length > 0 ? res[0].key[0] : 0
		}
	}

	return { schema: updatedSchema, result }
}

function processRecordQuery(db: TupleDb, schema: RecordDbSchema, type: string, q: QueryQuery) {
	const whereKeys = q.where ? Object.keys(q.where).sort() : []
	const sortKeys = q.sort || []

	// 1. Ensure an index exists for this specific query pattern
	const res = ensureIndex(db, schema, type, whereKeys, sortKeys)
	const indexName = res.indexName

	// 2. Scan
	// We can assert indexName is defined because ensureIndex now always returns 'primary' or a named index.
	const results = scanIndex(db, res.schema, type, indexName!, {
		eq: q.where,
		limit: q.limit,
		reverse: q.reverse,
	})

	return { schema: res.schema, result: results }
}

// --- Specific Ensure Logic ---

function matchIndex(fields: string[], whereKeys: string[], sortKeys: string[]) {
	if (fields.length < whereKeys.length + sortKeys.length) return false

	// 1. Check Where Keys (Set equality)
	const prefix = fields.slice(0, whereKeys.length)
	const prefixSet = new Set(prefix)
	if (prefixSet.size !== whereKeys.length) return false
	for (const k of whereKeys) {
		if (!prefixSet.has(k)) return false
	}

	// 2. Check Sort Keys (Order equality)
	const suffix = fields.slice(whereKeys.length, whereKeys.length + sortKeys.length)
	if (!isEqual(suffix, sortKeys)) return false

	return true
}

function ensureIndex(
	db: TupleDb,
	schema: RecordDbSchema,
	type: string,
	whereKeys: string[],
	sortKeys: string[] = []
): { schema: RecordDbSchema; indexName: string } {
	const primary = schema.records[type].primary

	if (matchIndex(primary, whereKeys, sortKeys)) return { schema, indexName: "primary" }

	// Check existing
	for (const [name, fields] of Object.entries(schema.records[type])) {
		if (name === "primary") continue
		if (matchIndex(fields, whereKeys, sortKeys)) return { schema, indexName: name }
	}

	// Create New
	const needed = union(whereKeys, sortKeys, primary)
	const indexName = `auto_idx_${needed.join("_")}`

	const newSchema = cloneDeep(schema)
	newSchema.records[type][indexName] = needed
	backfillRecordIndex(db, newSchema, type, indexName)
	saveSchema(db, newSchema)

	return { schema: newSchema, indexName }
}

// ============================================================================
// Low-Level Helpers (Scan, Keys, Math)
// ============================================================================

function scanIndex(
	db: TupleDb,
	schema: RecordDbSchema,
	type: string,
	indexName: string,
	args: ScanArgs
): any[] {
	const fields = schema.records[type][indexName]
	const primary = schema.records[type].primary

	// Map index fields to primary key positions
	const pkMap = primary.map((p) => {
		const idx = fields.indexOf(p)
		if (idx === -1) throw new Error(`Index ${indexName} missing PK field ${p}`)
		return idx
	})

	const prefixTuple = args.eq ? unrollKey(args.eq, fields) : []
	const listArgs = makeListArgs(args, prefixTuple.length, fields, args)

	return db
		.subspace([type, indexName, ...prefixTuple])
		.list(listArgs)
		.map(({ key }) => {
			const fullKey = [...prefixTuple, ...key]
			const pk = pkMap.map((idx) => fullKey[idx])
			return db.get([type, "primary", ...pk])
		})
}

function makeListArgs(
	args: ScanArgs & { limit?: number; reverse?: boolean },
	prefixLen: number,
	allFields: string[],
	orig: any
): ListArgs<Tuple> {
	const remaining = allFields.slice(prefixLen)
	return compactObj({
		limit: args.limit,
		reverse: args.reverse,
		gt: orig.gt ? unrollKey(orig.gt, remaining) : undefined,
		gte: orig.gte ? unrollKey(orig.gte, remaining) : undefined,
		lt: orig.lt ? unrollKey(orig.lt, remaining) : undefined,
		lte: orig.lte ? unrollKey(orig.lte, remaining) : undefined,
	})
}

function findMatches(db: TupleDb, schema: RecordDbSchema, sideDef: JoinSide, val: any): any[] {
	// Re-uses query logic to ensure indexes exist for the join
	const { result } = processQuery(db, schema, {
		from: sideDef.type,
		where: { [sideDef.on]: val },
	})
	return result
}

function increment(db: TupleDb, key: Tuple, delta: number) {
	const curr = (db.get(key) as number) || 0
	const next = curr + delta
	if (next <= 0) db.delete(key)
	else db.set(key, next)
}

function extractKey(obj: any, fields: string[]): Tuple {
	return fields.map((f) => {
		if (obj[f] === undefined) throw new Error(`Missing key field: ${f}`)
		return obj[f]
	})
}

function unrollKey(obj: any, fields: string[]): Tuple {
	const res: Tuple = []
	if (!obj) return res
	for (const f of fields) {
		if (f in obj) res.push(obj[f])
		else break
	}
	return res
}

function loadSchema(db: TupleDb): RecordDbSchema | null {
	return db.get(["_schema", "current"]) as RecordDbSchema
}

function saveSchema(db: TupleDb, s: RecordDbSchema) {
	db.set(["_schema", "current"], s)
}

// ============================================================================
// RecordDb Factory
// ============================================================================

export function recordDb(db: TupleDb, initialSchema: RecordDbSchema): RecordDb {
	let cachedSchema = loadSchema(db) || initialSchema
	if (!loadSchema(db)) saveSchema(db, initialSchema)

	const reload = () => {
		cachedSchema = loadSchema(db) || initialSchema
	}

	return {
		get: (args) => {
			reload()
			const schema = cachedSchema
			const pk = extractKey(args, schema.records[args.type].primary)
			return db.get([args.type, "primary", ...pk])
		},
		delete: (args) => {
			reload()
			const schema = cachedSchema
			const pk = extractKey(args, schema.records[args.type].primary)
			const oldRecord = db.get([args.type, "primary", ...pk])
			if (!oldRecord) return

			db.delete([args.type, "primary", ...pk])
			updateIndexes(db, schema, { type: args.type, oldRecord, newRecord: null })
		},
		set: (record) => {
			reload()
			const schema = cachedSchema
			const { type } = record
			const pk = extractKey(record, schema.records[type].primary)
			const oldRecord = db.get([type, "primary", ...pk])

			db.set([type, "primary", ...pk], record)
			updateIndexes(db, schema, { type, oldRecord, newRecord: record })
		},
		query: (q) => {
			reload()
			const { result } = processQuery(db, cachedSchema, q)
			return result
		},
	}
}
