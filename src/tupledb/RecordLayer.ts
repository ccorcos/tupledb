import { cloneDeep, isEqual, union } from "lodash-es"
import { compactObj } from "shared/compactObj"
import { ListArgs, Tuple, TupleDb } from "./types"

// ============================================================================
// Types
// ============================================================================

export type TypeSchema = {
	primary: string[]
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

export type AggregationOp = {
	kind: "count" | "sum" | "min" | "max"
	field?: string
}

export type IndexDefinition = {
	from: string | JoinSchema
	where?: { [key: string]: any }
	sort?: string[]
	groupBy?: string[]
	aggregate?: { [alias: string]: AggregationOp }
}

export type Schema = {
	types: { [name: string]: TypeSchema }
	indexes: { [name: string]: IndexDefinition }
}

export type RecordQuery = {
	from: string
	where?: Record<string, any>
	sort?: string[]
	reverse?: boolean
	limit?: number
	groupBy?: never
	aggregate?: never
}

export type AggregationQuery = {
	from: string
	where?: Record<string, any>
	groupBy?: string[]
	aggregate: Record<string, AggregationOp>
	sort?: never
	limit?: never
}

export type JoinQuery = {
	from: JoinSchema
	where?: Record<string, any>
	sort?: string[]
	reverse?: boolean
	limit?: number
	groupBy?: never
	aggregate?: never
}

export type Query = RecordQuery | AggregationQuery | JoinQuery

export type Change = {
	type: string
	oldRecord: any | null
	newRecord: any | null
}

export type RecordDb = {
	get: (args: { type: string; [key: string]: any }) => any | undefined
	delete: (args: { type: string; [key: string]: any }) => void
	set: (record: { type: string; [key: string]: any }) => void
	query: (query: Query) => any
}

// ============================================================================
// Schema Management
// ============================================================================

function loadSchema(db: TupleDb): Schema {
	const schema: Schema = { types: {}, indexes: {} }

	// Load Types
	const types = db.subspace(["_schema", "types"]).list()
	for (const { key, value } of types) {
		schema.types[key[0] as string] = value as TypeSchema
	}

	// Load Indexes
	const indexes = db.subspace(["_schema", "indexes"]).list()
	for (const { key, value } of indexes) {
		schema.indexes[key[0] as string] = value as IndexDefinition
	}

	return schema
}

function saveType(db: TupleDb, name: string, def: TypeSchema) {
	db.set(["_schema", "types", name], def)
}

function saveIndex(db: TupleDb, name: string, def: IndexDefinition) {
	db.set(["_schema", "indexes", name], def)
}

function deleteIndexDef(db: TupleDb, name: string) {
	db.delete(["_schema", "indexes", name])
}

// Helper to initialize schema if empty
function ensureSchema(db: TupleDb, initialSchema: Schema) {
	const current = loadSchema(db)
	if (Object.keys(current.types).length === 0 && Object.keys(current.indexes).length === 0) {
		for (const [name, def] of Object.entries(initialSchema.types)) {
			saveType(db, name, def)
		}
		for (const [name, def] of Object.entries(initialSchema.indexes)) {
			saveIndex(db, name, def)
		}
	}
}

// ============================================================================
// Helpers & Public API
// ============================================================================

export function isAmbiguousIndex(q: Query): boolean {
	// A query is "ambiguous" if its where-keys are not sorted,
	// or generally if it doesn't strictly match the canonical definition.
	// For now, we'll check if where keys are sorted.
	if (q.where) {
		const keys = Object.keys(q.where)
		const sorted = [...keys].sort()
		if (!isEqual(keys, sorted)) return true
	}
	// Add more checks if needed?
	return false
}

export function toUnambiguousIndex(q: Query): IndexDefinition {
	if (isAggregationQuery(q)) {
		return {
			from: q.from,
			groupBy: q.groupBy ? [...q.groupBy].sort() : [],
			aggregate: q.aggregate,
			where: q.where, // We don't sort where keys inside the object, but equality checks usually handle it.
		}
	}
	if (isJoinQuery(q)) {
		return {
			from: q.from,
		}
	}

	// Record Query
	const whereKeys = q.where ? Object.keys(q.where).sort() : []
	const sortKeys = q.sort || []
	const needed = union(whereKeys, sortKeys)

	return {
		from: q.from,
		sort: needed,
		where: q.where,
	}
}

// Check if a SUITABLE index exists
export function hasIndex(schema: Schema, q: Query): string | false {
	if (isAggregationQuery(q)) {
		const type = q.from
		for (const [name, def] of Object.entries(schema.indexes)) {
			if (def.from === type && def.aggregate && isEqual(def.groupBy?.sort(), q.groupBy?.sort())) {
				if (!isEqual(def.where, q.where)) continue
				let match = true
				for (const [alias, op] of Object.entries(q.aggregate)) {
					if (!def.aggregate[alias] || !isEqual(def.aggregate[alias], op)) {
						match = false
						break
					}
				}
				if (match) return name
			}
		}
		return false
	}

	if (isJoinQuery(q)) {
		const joinDef = q.from
		// The join index name is deterministic in processJoinQuery, but let's check definition
		for (const [name, def] of Object.entries(schema.indexes)) {
			if (isEqual(def.from, joinDef)) return name
		}
		return false
	}

	// Record Query
	const type = q.from
	const whereKeys = q.where ? Object.keys(q.where).sort() : []
	const sortKeys = q.sort || []
	const primary = schema.types[type]?.primary

	if (!primary) throw new Error(`Missing type definition for ${type}`)

	if (matchIndex(primary, whereKeys, sortKeys)) return "primary"

	for (const [name, def] of Object.entries(schema.indexes)) {
		if (def.from === type && !def.aggregate && typeof def.from === "string") {
			const indexFields = union(def.sort || [], primary)
			if (matchIndex(indexFields, whereKeys, sortKeys)) {
				if (def.where && !isEqual(def.where, q.where)) continue
				return name
			}
		}
	}
	return false
}

export function createIndex(
	db: TupleDb,
	schema: Schema,
	q: Query
): { schema: Schema; indexName: string } {
	if (isJoinQuery(q)) {
		return createJoinIndex(db, schema, q)
	}
	if (isAggregationQuery(q)) {
		return createAggregationIndex(db, schema, q)
	}
	return createRecordIndex(db, schema, q)
}

function createRecordIndex(
	db: TupleDb,
	schema: Schema,
	q: RecordQuery
): { schema: Schema; indexName: string } {
	const def = toUnambiguousIndex(q)
	const indexName = getCanonicalIndexName(def)

	if (schema.indexes[indexName]) {
		return { schema, indexName }
	}

	const newSchema = cloneDeep(schema)
	newSchema.indexes[indexName] = def

	backfillRecordIndex(db, newSchema, indexName)
	saveIndex(db, indexName, def)

	return { schema: newSchema, indexName }
}

function createAggregationIndex(
	db: TupleDb,
	schema: Schema,
	q: AggregationQuery
): { schema: Schema; indexName: string } {
	const def = toUnambiguousIndex(q)
	const indexName = getCanonicalIndexName(def)

	if (schema.indexes[indexName]) {
		return { schema, indexName }
	}

	const newSchema = cloneDeep(schema)
	newSchema.indexes[indexName] = def

	backfillAggregationIndex(db, newSchema, indexName)
	saveIndex(db, indexName, def)

	return { schema: newSchema, indexName }
}

function createJoinIndex(
	db: TupleDb,
	schema: Schema,
	q: JoinQuery
): { schema: Schema; indexName: string } {
	const def = toUnambiguousIndex(q)
	const indexName = getCanonicalIndexName(def)

	if (schema.indexes[indexName]) {
		return { schema, indexName }
	}

	const newSchema = cloneDeep(schema)
	newSchema.indexes[indexName] = def

	// For Join, we also need to ensure Record indexes on both sides
	const joinDef = q.from as JoinSchema
	// Ensure Left
	const { schema: s1 } = ensureRecordIndex(db, newSchema, joinDef.left.type, {
		from: joinDef.left.type,
		sort: [joinDef.left.on],
	})
	// Ensure Right
	const { schema: s2 } = ensureRecordIndex(db, s1, joinDef.right.type, {
		from: joinDef.right.type,
		sort: [joinDef.right.on],
	})
	Object.assign(newSchema, s2) // Merge back changes

	backfillJoinIndex(db, newSchema, indexName)
	saveIndex(db, indexName, def)

	return { schema: newSchema, indexName }
}

export function deleteIndex(db: TupleDb, schema: Schema, q: Query): Schema {
	const def = toUnambiguousIndex(q)
	// Find the exact matching index.
	// Note: hasIndex finds *suitable*, we want *exact* (or canonical name match)

	const targetName = getCanonicalIndexName(def)

	if (!schema.indexes[targetName]) {
		// Maybe check if there is an index with identical def but different name?
		// For now, rely on canonical name.
		return schema
	}

	const newSchema = cloneDeep(schema)
	delete newSchema.indexes[targetName]

	deleteIndexDef(db, targetName)
	// Also need to delete the data!
	if (isAggregationQuery(q)) {
		clearSubspace(db, ["aggregation", targetName])
	} else if (isJoinQuery(q)) {
		clearSubspace(db, ["join", targetName])
	} else {
		clearSubspace(db, [def.from as string, targetName])
	}

	return newSchema
}

function clearSubspace(db: TupleDb, prefix: Tuple) {
	// TupleDb doesn't have range delete?
	// We have to list and delete.
	const items = db.subspace(prefix).list()
	for (const { key } of items) {
		db.subspace(prefix).delete(key)
	}
}

// ============================================================================
// Write Path: View Maintenance
// ============================================================================

function updateIndexes(db: TupleDb, schema: Schema, change: Change) {
	const { type, oldRecord, newRecord } = change

	const update = (fn: (r: any, d: number) => void) => {
		if (oldRecord) fn(oldRecord, -1)
		if (newRecord) fn(newRecord, 1)
	}

	for (const [indexName, def] of Object.entries(schema.indexes)) {
		if (typeof def.from !== "string") {
			update((r, d) => updateJoinIndex(db, schema, indexName, def.from as JoinSchema, r, d))
			continue
		}

		if (def.from === type) {
			if (def.aggregate) {
				update((r, d) => updateAggregationIndex(db, indexName, def, r, d))
			} else {
				update((r, d) => updateRecordIndex(db, schema, type, indexName, def, r, d))
			}
		}
	}
}

function updateRecordIndex(
	db: TupleDb,
	schema: Schema,
	type: string,
	indexName: string,
	def: IndexDefinition,
	record: any,
	delta: number
) {
	if (def.where && !matchWhere(record, def.where)) return

	const sortKeys = def.sort || []

	// We need to fetch the primary key definition for this type to ensure uniqueness
	const typeDef = schema.types[type]
	if (!typeDef) throw new Error(`Missing type definition for ${type}`)

	const primaryKeys = typeDef.primary

	// indexFields = union of sort and primary
	const indexFields = union(sortKeys, primaryKeys)
	const keyValues = extractKey(record, indexFields)

	const dbKey = [type, indexName, ...keyValues]

	if (delta === 1) db.set(dbKey, null)
	else db.delete(dbKey)
}

function updateAggregationIndex(
	db: TupleDb,
	indexName: string,
	def: IndexDefinition,
	record: any,
	delta: number
) {
	if (def.where && !matchWhere(record, def.where)) return

	const groupKey = ["aggregation", indexName, ...extractKey(record, def.groupBy || [])]

	for (const [alias, op] of Object.entries(def.aggregate!)) {
		const val = op.kind === "count" ? 1 : record[op.field!]
		const aggKey = [...groupKey, alias]

		if (op.kind === "count") {
			increment(db, aggKey, delta)
		} else if (op.kind === "sum") {
			increment(db, aggKey, (val as number) * delta)
		} else if (op.kind === "min" || op.kind === "max") {
			const valueKey = [...aggKey, val]
			increment(db, valueKey, delta)
		}
	}
}

function updateJoinIndex(
	db: TupleDb,
	schema: Schema,
	indexName: string,
	joinSchema: JoinSchema,
	record: any,
	delta: number
) {
	const sides: ("left" | "right")[] = ["left", "right"]
	for (const side of sides) {
		const mySideDef = joinSchema[side]
		const otherSideDef = joinSchema[side === "left" ? "right" : "left"]

		if (record.type === mySideDef.type) {
			// Find matches
			const matches = processQuery(db, schema, {
				from: otherSideDef.type,
				where: { [otherSideDef.on]: record[mySideDef.on] },
			}).result

			for (const match of matches) {
				const left = side === "left" ? record : match
				const right = side === "right" ? record : match

				const keyValues = joinSchema.key.map(({ side: s, field }) =>
					s === "left" ? left[field] : right[field]
				)

				increment(db, ["join", indexName, ...keyValues], delta)
			}
		}
	}
}

// ============================================================================
// Read Path: Query Planner
// ============================================================================

function processQuery(db: TupleDb, schema: Schema, q: Query): { schema: Schema; result: any } {
	// 1. Identify intent
	if (isAggregationQuery(q)) {
		return processAggregationQuery(db, schema, q)
	}

	if (isJoinQuery(q)) {
		return processJoinQuery(db, schema, q.from, q)
	}

	return processRecordQuery(db, schema, q.from, q)
}

function isAggregationQuery(q: Query): q is AggregationQuery {
	return (q as AggregationQuery).aggregate !== undefined
}

function isJoinQuery(q: Query): q is JoinQuery {
	return typeof q.from === "object"
}

function processRecordQuery(db: TupleDb, schema: Schema, type: string, q: RecordQuery) {
	const { indexName, schema: newSchema } = ensureRecordIndex(db, schema, type, q)

	if (indexName === "primary") {
		return { schema: newSchema, result: processPrimaryScan(db, newSchema, type, q) }
	}

	return { schema: newSchema, result: processSecondaryIndexScan(db, newSchema, indexName, q) }
}

function processAggregationQuery(db: TupleDb, schema: Schema, q: AggregationQuery) {
	const type = q.from

	const existing = hasIndex(schema, q)
	const { indexName, schema: newSchema } = existing
		? { indexName: existing as string, schema }
		: createAggregationIndex(db, schema, q)

	// Execute
	const def = newSchema.indexes[indexName]
	const groupKey = ["aggregation", indexName, ...extractKey(q.where || {}, def.groupBy || [])]

	const result: any = {}
	for (const [alias, op] of Object.entries(q.aggregate!)) {
		const aggKey = [...groupKey, alias]
		if (op.kind === "count" || op.kind === "sum") {
			result[alias] = (db.get(aggKey) as number) || 0
		} else {
			const listOpts = { limit: 1, reverse: op.kind === "max" }
			const res = db.subspace(aggKey).list(listOpts)
			result[alias] = res.length > 0 ? res[0].key[0] : 0
		}
	}

	return { schema: newSchema, result }
}

function processJoinQuery(db: TupleDb, schema: Schema, joinDef: JoinSchema, q: JoinQuery) {
	// Ensure indexes on join keys exist (record indexes) handled by createIndex now?
	// createIndex for JoinQuery calls ensureRecordIndex for left/right.

	const existing = hasIndex(schema, q)
	const { indexName, schema: updatedSchema } = existing
		? { indexName: existing as string, schema }
		: createJoinIndex(db, schema, q)

	return { schema: updatedSchema, result: processJoinScan(db, updatedSchema, indexName, q) }
}

function processPrimaryScan(db: TupleDb, schema: Schema, type: string, q: RecordQuery) {
	const typeDef = schema.types[type]
	const prefixTuple = q.where ? unrollKey(q.where, typeDef.primary) : []
	const listArgs = makeListArgs(
		{ eq: q.where, limit: q.limit, reverse: q.reverse, ...q.where },
		prefixTuple.length,
		typeDef.primary,
		q
	)
	return db
		.subspace([type, "primary", ...prefixTuple])
		.list(listArgs)
		.map(({ value }) => value)
}

function processJoinScan(db: TupleDb, schema: Schema, indexName: string, q: JoinQuery) {
	const def = schema.indexes[indexName]
	if (!def) throw new Error(`Index ${indexName} not found`)

	const joinDef = def.from as JoinSchema
	const keyFields = joinDef.key.map((k) => k.field)

	const prefixTuple = q.where ? unrollKey(q.where, keyFields) : []
	const listArgs = makeListArgs(
		{ eq: q.where, limit: q.limit, reverse: q.reverse, ...q.where }, // mixing args for simplicity
		prefixTuple.length,
		keyFields,
		q
	)

	return db
		.subspace(["join", indexName, ...prefixTuple])
		.list(listArgs)
		.filter((item) => (item.value as number) > 0)
		.map(({ key }) => {
			const fullKey = [...prefixTuple, ...key]
			const obj: any = {}
			for (const [i, f] of keyFields.entries()) obj[f] = fullKey[i]
			return obj
		})
}

function processSecondaryIndexScan(db: TupleDb, schema: Schema, indexName: string, q: RecordQuery) {
	const def = schema.indexes[indexName]
	if (!def) throw new Error(`Index ${indexName} not found`)

	const type = def.from as string
	const typeDef = schema.types[type]

	const sortKeys = def.sort || []
	const indexFields = union(sortKeys, typeDef.primary)

	const prefixTuple = q.where ? unrollKey(q.where, indexFields) : []
	const listArgs = makeListArgs(
		{ eq: q.where, limit: q.limit, reverse: q.reverse, ...q.where },
		prefixTuple.length,
		indexFields,
		q
	)

	return db
		.subspace([type, indexName, ...prefixTuple])
		.list(listArgs)
		.map(({ key }) => {
			const fullKey = [...prefixTuple, ...key]

			// Reconstruct partial object from key
			const keyObj: any = {}
			for (let i = 0; i < indexFields.length; i++) {
				keyObj[indexFields[i]] = fullKey[i]
			}

			// Extract PK in correct order
			const pk = typeDef.primary.map((f) => keyObj[f])

			return db.get([type, "primary", ...pk])
		})
		.filter((r) => r !== undefined)
}

// ============================================================================
// Helpers
// ============================================================================

function getCanonicalIndexName(def: IndexDefinition): string {
	if (typeof def.from === "object") {
		// Join
		const joinDef = def.from as JoinSchema
		return `auto_join_${joinDef.left.type}_${joinDef.left.on}_${joinDef.right.type}_${joinDef.right.on}`
	}

	// Base name
	const parts = ["auto"]

	// Sort / GroupBy
	if (def.groupBy) {
		parts.push("agg", def.from as string)
		if (def.groupBy.length) parts.push("g", ...def.groupBy.sort())
		// Aggregates
		if (def.aggregate) {
			const aggParts: string[] = []
			for (const [alias, op] of Object.entries(def.aggregate)) {
				aggParts.push(`${alias}:${op.kind}${op.field ? "-" + op.field : ""}`)
			}
			aggParts.sort()
			parts.push("a", ...aggParts)
		}
	} else {
		parts.push("idx", def.from as string)
		if (def.sort && def.sort.length) {
			parts.push("s", ...def.sort)
		}
	}

	// Where
	if (def.where) {
		const whereParts: string[] = []
		for (const [k, v] of Object.entries(def.where)) {
			whereParts.push(`${k}-${v}`)
		}
		whereParts.sort()
		parts.push("w", ...whereParts)
	}

	return parts.join("_")
}

function ensureRecordIndex(
	db: TupleDb,
	schema: Schema,
	type: string,
	q: RecordQuery
): { schema: Schema; indexName: string } {
	const existing = hasIndex(schema, q)
	if (existing) return { schema, indexName: existing }

	return createRecordIndex(db, schema, q)
}

function backfillRecordIndex(db: TupleDb, schema: Schema, indexName: string) {
	const def = schema.indexes[indexName]
	const type = def.from as string
	const records = db
		.subspace([type, "primary"])
		.list()
		.map((i) => i.value)
	for (const r of records) {
		updateRecordIndex(db, schema, type, indexName, def, r, 1)
	}
}

function backfillAggregationIndex(db: TupleDb, schema: Schema, indexName: string) {
	const def = schema.indexes[indexName]
	const type = def.from as string
	const records = db
		.subspace([type, "primary"])
		.list()
		.map((i) => i.value)
	for (const r of records) {
		updateAggregationIndex(db, indexName, def, r, 1)
	}
}

function backfillJoinIndex(db: TupleDb, schema: Schema, indexName: string) {
	const def = schema.indexes[indexName]
	const joinDef = def.from as JoinSchema
	const records = db
		.subspace([joinDef.left.type, "primary"])
		.list()
		.map((i) => i.value)
	for (const leftRecord of records) {
		const matches = processQuery(db, schema, {
			from: joinDef.right.type,
			where: { [joinDef.right.on]: leftRecord[joinDef.left.on] },
		}).result
		for (const rightRecord of matches) {
			const keyValues = joinDef.key.map(({ side: s, field }) =>
				s === "left" ? leftRecord[field] : rightRecord[field]
			)
			increment(db, ["join", indexName, ...keyValues], 1)
		}
	}
}

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

function matchWhere(record: any, where: Record<string, any>): boolean {
	for (const [k, v] of Object.entries(where)) {
		if (record[k] !== v) return false
	}
	return true
}

function makeListArgs(
	args: any,
	prefixLen: number,
	allFields: string[],
	orig: RecordQuery | JoinQuery
): ListArgs<Tuple> {
	return compactObj({
		limit: args.limit,
		reverse: args.reverse,
	})
}

// ============================================================================
// RecordDb Factory
// ============================================================================

export function recordDb(db: TupleDb, initialSchema: Schema): RecordDb {
	ensureSchema(db, initialSchema)

	// Helper to get fresh schema on every call
	const getSchema = () => loadSchema(db)

	return {
		get: (args) => {
			const schema = getSchema()
			// We need primary key def
			const typeDef = schema.types[args.type]
			const pk = extractKey(args, typeDef.primary)
			return db.get([args.type, "primary", ...pk])
		},
		delete: (args) => {
			const schema = getSchema()
			const typeDef = schema.types[args.type]
			const pk = extractKey(args, typeDef.primary)
			const oldRecord = db.get([args.type, "primary", ...pk])
			if (!oldRecord) return

			db.delete([args.type, "primary", ...pk])
			updateIndexes(db, schema, { type: args.type, oldRecord, newRecord: null })
		},
		set: (record) => {
			const schema = getSchema()
			const { type } = record
			const typeDef = schema.types[type]
			const pk = extractKey(record, typeDef.primary)
			const oldRecord = db.get([type, "primary", ...pk])

			db.set([type, "primary", ...pk], record)
			updateIndexes(db, schema, { type, oldRecord, newRecord: record })
		},
		query: (q) => {
			const schema = getSchema()
			const { result } = processQuery(db, schema, q)
			return result
		},
	}
}
