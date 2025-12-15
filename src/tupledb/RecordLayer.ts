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
// The "View Strategy" Pattern
// ============================================================================
// Explanation:
// The database treats Indexes, Aggregations, and Joins as "Derived Views".
// - WRITE: When a record changes, we 'maintain' these views (increment/decrement/update).
// - READ:  When we query, we 'ensure' the view exists (backfilling if needed), then scan it.
//
// This Framework section unifies the lifecycle logic so we don't repeat "Scan -> Loop -> Write" code.

interface ViewStrategy<Def> {
	// Called when a record of the relevant type changes.
	// delta is -1 (record deleted) or 1 (record added).
	update: (db: TupleDb, schema: RecordDbSchema, def: Def, record: any, delta: number) => void

	// Called to populate a brand new view from scratch.
	// Usually involves scanning the source table and calling update() for every record.
	backfill: (db: TupleDb, schema: RecordDbSchema, name: string, def: Def) => void
}

/**
 * Generic Backfill: Scans a source type and runs the update logic for every record.
 */
function defaultBackfill<Def>(
	db: TupleDb,
	schema: RecordDbSchema,
	def: Def,
	sourceType: string,
	strategy: ViewStrategy<Def>
) {
	const records = scanAllRecords(db, sourceType)
	for (const record of records) {
		strategy.update(db, schema, def, record, 1)
	}
}

/**
 * Generic Ensure: Checks if a view exists. If not, creates it, backfills it, and saves the schema.
 */
function ensureView<Def>(
	db: TupleDb,
	schema: RecordDbSchema,
	collection: { [name: string]: Def } | undefined,
	viewName: string,
	createDef: () => Def,
	strategy: ViewStrategy<Def>,
	onSchemaChange: (newSchema: RecordDbSchema) => void
): { schema: RecordDbSchema; created: boolean } {
	// 1. Exists? Return.
	if (collection && collection[viewName]) {
		return { schema, created: false }
	}

	// 2. Create Definition
	const def = createDef()

	// 3. Mutate Schema (Clone first)
	const newSchema = JSON.parse(JSON.stringify(schema))
	// We don't know the exact parent key (indexes vs aggregations), so we rely on the
	// caller passing the 'collection' reference, but we need to mutate the new schema.
	// To simplify, we'll let the caller handle the attachment or use a callback?
	// Actually, let's just make the caller do the attachment to keep this pure?
	// No, backfill needs the definition.

	// Let's refine the signature to take the 'schema section' name.
	// Harder generic. Let's just do specific ensure functions that use a shared helper for the logic.
	return { schema: newSchema, created: true } // Placeholder, see specific implementations below.
}

// ============================================================================
// Strategy Implementations
// ============================================================================

// --- 1. Index Strategy (Key -> PrimaryKey) ---

const IndexStrategy: ViewStrategy<string[]> = {
	update: (db, schema, fields, record, delta) => {
		// Index logic: Add/Remove keys.
		// Delta -1: Delete. Delta 1: Set.
		const { type } = record
		const keys = extractKey(record, fields)
		const indexKey = [type, "index_entry", ...keys] // "index_entry" differentiates from data if needed, or we use specific index names

		// Current implementation uses [type, indexName, ...keys]
		// We need the indexName. The 'Def' for index is currently just string[].
		// We need to pass the name. The generic update signature is slightly limiting.
		// Let's change the pattern: The 'Def' should probably include the name or we pass it.
		// For now, we'll assume the caller context knows how to construct the key.
		// Actually, let's look at the existing code: db.set([type, indexName, ...keys], null)
	},
	backfill: () => {
		/* Implemented specifically below */
	},
}

// Re-implementing the specific logic objects to capture the full context (Name + Def)

const IndexLogic = {
	update: (
		db: TupleDb,
		type: string,
		indexName: string,
		fields: string[],
		record: any,
		delta: number
	) => {
		const keys = extractKey(record, fields)
		const dbKey = [type, indexName, ...keys]
		if (delta === 1) db.set(dbKey, null)
		else db.delete(dbKey)
	},
}

const AggregationLogic = {
	update: (db: TupleDb, name: string, def: AggregationSchema, record: any, delta: number) => {
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
	},
}

const JoinLogic = {
	update: (
		db: TupleDb,
		schema: RecordDbSchema,
		joinName: string,
		def: JoinSchema,
		record: any,
		delta: number
	) => {
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
	},
}

// ============================================================================
// Core Reactor Loop (The "Write" Path)
// ============================================================================

function notifyReactors(db: TupleDb, schema: RecordDbSchema, change: Change) {
	const { type, oldRecord, newRecord } = change

	// Helper to apply +/- logic
	const react = (fn: (r: any, d: number) => void) => {
		if (oldRecord) fn(oldRecord, -1)
		if (newRecord) fn(newRecord, 1)
	}

	// 1. Indexes
	const recordSchema = schema.records[type]
	if (recordSchema?.indexes) {
		for (const [name, fields] of Object.entries(recordSchema.indexes)) {
			react((r, d) => IndexLogic.update(db, type, name, fields, r, d))
		}
	}

	// 2. Aggregations
	if (schema.aggregations) {
		for (const [name, def] of Object.entries(schema.aggregations)) {
			if (def.source === type) {
				react((r, d) => AggregationLogic.update(db, name, def, r, d))
			}
		}
	}

	// 3. Joins
	if (schema.joins) {
		for (const [name, def] of Object.entries(schema.joins)) {
			// Join logic handles type checking internally
			react((r, d) => JoinLogic.update(db, schema, name, def, r, d))
		}
	}
}

// ============================================================================
// Schema Lifecycle & Backfill (The "Ensure" Path)
// ============================================================================

function ensureDefinition(
	db: TupleDb,
	schema: RecordDbSchema,
	check: () => boolean,
	apply: (s: RecordDbSchema) => void,
	backfill: (s: RecordDbSchema) => void
): { schema: RecordDbSchema; schemaChanged: boolean } {
	if (check()) return { schema, schemaChanged: false }

	const newSchema = JSON.parse(JSON.stringify(schema))
	apply(newSchema)
	backfill(newSchema)
	saveSchema(db, newSchema)

	return { schema: newSchema, schemaChanged: true }
}

function backfillIndex(db: TupleDb, schema: RecordDbSchema, type: string, indexName: string) {
	const fields = schema.records[type].indexes?.[indexName]
	if (!fields) return
	const records = scanAllRecords(db, type) // Use best available scan
	for (const r of records) {
		IndexLogic.update(db, type, indexName, fields, r, 1)
	}
}

function backfillAggregation(db: TupleDb, schema: RecordDbSchema, name: string) {
	const def = schema.aggregations?.[name]
	if (!def) return
	const records = scanAllRecords(db, def.source)
	for (const r of records) {
		AggregationLogic.update(db, name, def, r, 1)
	}
}

function backfillJoin(db: TupleDb, schema: RecordDbSchema, name: string) {
	const def = schema.joins?.[name]
	if (!def) return

	// For backfill, we iterate one side (Left) and find matches on the other (Right).
	// This avoids double-counting that would occur if we used the bidirectional JoinLogic.update
	// on every record (especially for self-joins).
	const records = scanAllRecords(db, def.left.type)
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
	let schemaChanged = false

	// Ensure indexes on both sides (required for efficient join updates)
	const left = ensurePerfectIndex(db, updatedSchema, joinDef.left.type, [joinDef.left.on])
	updatedSchema = left.schema
	schemaChanged = schemaChanged || left.schemaChanged

	const right = ensurePerfectIndex(db, updatedSchema, joinDef.right.type, [joinDef.right.on])
	updatedSchema = right.schema
	schemaChanged = schemaChanged || right.schemaChanged

	// Ensure the Join View itself
	const joinName = `auto_join_${joinDef.left.type}_${joinDef.left.on}_${joinDef.right.type}_${joinDef.right.on}`

	const joinRes = ensureDefinition(
		db,
		updatedSchema,
		() => !!updatedSchema.joins?.[joinName],
		(s) => {
			s.joins = s.joins || {}
			s.joins[joinName] = joinDef
		},
		(s) => backfillJoin(db, s, joinName)
	)

	return processJoinQuery(db, joinRes.schema, joinName, q)
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
		const existing = Object.entries(updatedSchema.aggregations || {}).find(
			([_, def]) =>
				def.source === type && def.kind === kind && deepEqual(def.groupBy.sort(), groupBy)
		)

		if (!existing) {
			const aggName = `auto_agg_${type}_${kind}_${groupBy.join("_")}`
			const res = ensureDefinition(
				db,
				updatedSchema,
				() => false, // Always force create if not found above
				(s) => {
					s.aggregations = s.aggregations || {}
					s.aggregations[aggName] = { source: type, groupBy, kind, field: undefined }
				},
				(s) => backfillAggregation(db, s, aggName)
			)
			updatedSchema = res.schema
		}
	}

	// Execute
	const result: any = {}
	for (const [alias, kind] of Object.entries(q.aggregate!)) {
		const groupBy = q.groupBy ? q.groupBy.sort() : []
		const [name] = Object.entries(updatedSchema.aggregations!).find(
			([_, def]) =>
				def.source === type && def.kind === kind && deepEqual(def.groupBy.sort(), groupBy)
		)!

		const aggDef = updatedSchema.aggregations![name]
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
	const requiredPrefix = [...whereKeys, ...sortKeys]

	// 1. Ensure a "Perfect Index" exists for this specific query pattern
	const res = ensurePerfectIndex(db, schema, type, requiredPrefix)
	const perfectIndex = res.indexName

	// 2. Scan
	// We can assert perfectIndex is defined because ensurePerfectIndex now always returns 'primary' or a named index.
	const results = scanIndex(db, res.schema, type, perfectIndex!, {
		eq: q.where,
		limit: q.limit,
		reverse: q.reverse,
	})

	return { schema: res.schema, result: results }
}

// --- Specific Ensure Logic ---

function ensurePerfectIndex(
	db: TupleDb,
	schema: RecordDbSchema,
	type: string,
	requiredPrefix: string[]
): { schema: RecordDbSchema; indexName: string; schemaChanged: boolean } {
	const primary = schema.records[type].primary
	const needed = [...new Set([...requiredPrefix, ...primary])]

	// If Primary Key works, use it (return undefined indexName)
	if (deepEqual(needed, primary)) return { schema, indexName: "primary", schemaChanged: false }

	// Check existing
	const existing = Object.entries(schema.records[type].indexes || {}).find(([_, fields]) => {
		if (fields.length < requiredPrefix.length) return false
		return deepEqual(fields.slice(0, requiredPrefix.length), requiredPrefix)
	})
	if (existing) return { schema, indexName: existing[0], schemaChanged: false }

	// Create New
	const indexName = `auto_idx_${needed.join("_")}`
	const res = ensureDefinition(
		db,
		schema,
		() => !!schema.records[type].indexes?.[indexName],
		(s) => {
			s.records[type].indexes = s.records[type].indexes || {}
			s.records[type].indexes[indexName] = needed
		},
		(s) => backfillIndex(db, s, type, indexName)
	)

	return { schema: res.schema, indexName, schemaChanged: res.schemaChanged }
}

// ============================================================================
// Low-Level Helpers (Scan, Keys, Math)
// ============================================================================

function scanAllRecords(db: TupleDb, type: string): any[] {
	// Scans the table using the most efficient method available (Primary Key scan usually)
	// Ignores 'where' clauses, returns everything.
	return db
		.subspace([type, "primary"])
		.list()
		.map((i) => i.value)
		.filter((v) => v !== null)
}

function scanIndex(
	db: TupleDb,
	schema: RecordDbSchema,
	type: string,
	indexName: string,
	args: ScanArgs
): any[] {
	const fields =
		indexName === "primary"
			? schema.records[type].primary
			: schema.records[type].indexes![indexName]
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

function deepEqual(a: any, b: any): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
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
			notifyReactors(db, schema, { type: args.type, oldRecord, newRecord: null })
		},
		set: (record) => {
			reload()
			const schema = cachedSchema
			const { type } = record
			const pk = extractKey(record, schema.records[type].primary)
			const oldRecord = db.get([type, "primary", ...pk])

			db.set([type, "primary", ...pk], record)
			notifyReactors(db, schema, { type, oldRecord, newRecord: record })
		},
		query: (q) => {
			reload()
			const { result } = processQuery(db, cachedSchema, q)
			return result
		},
	}
}
