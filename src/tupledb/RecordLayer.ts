import { cloneDeep, isEqual, union } from "lodash-es"
import md5 from "md5"
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

export type QueryQuery = {
	from: string | JoinSchema
	where?: Record<string, any>
	sort?: string[]
	reverse?: boolean
	limit?: number
	groupBy?: string[]
	aggregate?: Record<string, AggregationOp>
}

export type Change = {
	type: string
	oldRecord: any | null
	newRecord: any | null
}

export type RecordDb = {
	get: (args: { type: string; [key: string]: any }) => any | undefined
	delete: (args: { type: string; [key: string]: any }) => void
	set: (record: { type: string; [key: string]: any }) => void
	query: (query: QueryQuery) => any
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

function processQuery(db: TupleDb, schema: Schema, q: QueryQuery): { schema: Schema; result: any } {
	// 1. Identify intent
	if (q.aggregate) {
		return processAggregationQuery(db, schema, q)
	}

	if (typeof q.from === "object") {
		return processJoinQuery(db, schema, q.from as JoinSchema, q)
	}

	const target = q.from as string
	if (schema.indexes[target]) {
		return processIndexScan(db, schema, target, q)
	}

	return processRecordQuery(db, schema, target, q)
}

function processRecordQuery(db: TupleDb, schema: Schema, type: string, q: QueryQuery) {
	// 1. Find or Create Index
	const { indexName, schema: newSchema } = ensureRecordIndex(db, schema, type, q)
	return processIndexScan(db, newSchema, indexName, q, { type })
}

function processAggregationQuery(db: TupleDb, schema: Schema, q: QueryQuery) {
	const type = q.from as string

	// Find matching aggregation index
	let indexName: string | undefined
	for (const [name, def] of Object.entries(schema.indexes)) {
		if (def.from === type && def.aggregate && isEqual(def.groupBy?.sort(), q.groupBy?.sort())) {
			// Check where clause match (Strict for now)
			if (!isEqual(def.where, q.where)) continue

			// Logic: The index must have ALL the aggregates requested in `q.aggregate`.
			let match = true
			for (const [alias, op] of Object.entries(q.aggregate!)) {
				if (!def.aggregate[alias] || !isEqual(def.aggregate[alias], op)) {
					match = false
					break
				}
			}
			if (match) {
				indexName = name
				break
			}
		}
	}

	let newSchema = schema
	if (!indexName) {
		// Create new
		const suffix = md5(JSON.stringify({ g: q.groupBy, a: q.aggregate, w: q.where }))
		indexName = `auto_agg_${type}_${suffix}`

		const def: IndexDefinition = {
			from: type,
			groupBy: q.groupBy,
			aggregate: q.aggregate,
			where: q.where, // If we support conditional aggs
		}
		newSchema = cloneDeep(schema)
		newSchema.indexes[indexName] = def
		backfillIndex(db, newSchema, indexName)
		saveIndex(db, indexName, def)
	}

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

function processJoinQuery(db: TupleDb, schema: Schema, joinDef: JoinSchema, q: QueryQuery) {
	// 1. Ensure indexes on join keys exist (record indexes)
	// We request FULL indexes (sort by ON key) so they can be reused for any value match.
	let updatedSchema = schema

	// Ensure Left Index (Full)
	const { schema: s1 } = ensureRecordIndex(db, updatedSchema, joinDef.left.type, {
		from: joinDef.left.type,
		sort: [joinDef.left.on],
	})
	updatedSchema = s1

	// Ensure Right Index (Full)
	const { schema: s2 } = ensureRecordIndex(db, updatedSchema, joinDef.right.type, {
		from: joinDef.right.type,
		sort: [joinDef.right.on],
	})
	updatedSchema = s2

	// 2. Ensure Join Index
	const joinName = `auto_join_${joinDef.left.type}_${joinDef.left.on}_${joinDef.right.type}_${joinDef.right.on}`

	if (!updatedSchema.indexes[joinName]) {
		const newSchema = cloneDeep(updatedSchema)
		const def: IndexDefinition = {
			from: joinDef,
		}
		newSchema.indexes[joinName] = def
		backfillIndex(db, newSchema, joinName)
		saveIndex(db, joinName, def)
		updatedSchema = newSchema
	}

	return processIndexScan(db, updatedSchema, joinName, q)
}

function processIndexScan(
	db: TupleDb,
	schema: Schema,
	indexName: string,
	q: QueryQuery,
	options?: { type?: string }
): { schema: Schema; result: any } {
	// Handle Primary Scan
	if (indexName === "primary") {
		const type = options?.type
		if (!type) throw new Error("Primary scan requires type")
		const typeDef = schema.types[type]
		const prefixTuple = q.where ? unrollKey(q.where, typeDef.primary) : []
		const listArgs = makeListArgs(
			{ eq: q.where, limit: q.limit, reverse: q.reverse, ...q.where },
			prefixTuple.length,
			typeDef.primary,
			q
		)
		const results = db
			.subspace([type, "primary", ...prefixTuple])
			.list(listArgs)
			.map(({ value }) => value)
		return { schema, result: results }
	}

	const def = schema.indexes[indexName]
	if (!def) throw new Error(`Index ${indexName} not found`)

	if (typeof def.from !== "string") {
		// Join Scan
		const joinDef = def.from as JoinSchema
		const keyFields = joinDef.key.map((k) => k.field)

		const prefixTuple = q.where ? unrollKey(q.where, keyFields) : []
		const listArgs = makeListArgs(
			{ eq: q.where, limit: q.limit, reverse: q.reverse, ...q.where }, // mixing args for simplicity
			prefixTuple.length,
			keyFields,
			q
		)

		const results = db
			.subspace(["join", indexName, ...prefixTuple])
			.list(listArgs)
			.filter((item) => (item.value as number) > 0)
			.map(({ key }) => {
				const fullKey = [...prefixTuple, ...key]
				const obj: any = {}
				for (const [i, f] of keyFields.entries()) obj[f] = fullKey[i]
				return obj
			})

		return { schema, result: results }
	} else {
		// Secondary Index Scan
		const type = def.from
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

		const results = db
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

		return { schema, result: results }
	}
}

// ============================================================================
// Helpers
// ============================================================================

function ensureRecordIndex(
	db: TupleDb,
	schema: Schema,
	type: string,
	q: QueryQuery
): { schema: Schema; indexName: string } {
	const whereKeys = q.where ? Object.keys(q.where).sort() : []
	const sortKeys = q.sort || []

	const primary = schema.types[type].primary
	if (matchIndex(primary, whereKeys, sortKeys)) return { schema, indexName: "primary" }

	// Verify existing indexes
	for (const [name, def] of Object.entries(schema.indexes)) {
		if (def.from === type && !def.aggregate && typeof def.from === "string") {
			const indexFields = union(def.sort || [], primary)
			if (matchIndex(indexFields, whereKeys, sortKeys)) {
				// Allow reuse if def.where is undefined (full index)
				if (def.where && !isEqual(def.where, q.where)) continue
				return { schema, indexName: name }
			}
		}
	}

	// Create new
	const needed = union(whereKeys, sortKeys)
	const suffix = md5(JSON.stringify({ s: needed, w: q.where }))
	const indexName = `auto_idx_${type}_${suffix}`

	const newSchema = cloneDeep(schema)
	const def: IndexDefinition = {
		from: type,
		sort: needed,
		where: q.where, // Persist where clause
	}
	newSchema.indexes[indexName] = def
	backfillIndex(db, newSchema, indexName)
	saveIndex(db, indexName, def)

	return { schema: newSchema, indexName }
}

function backfillIndex(db: TupleDb, schema: Schema, indexName: string) {
	const def = schema.indexes[indexName]

	if (typeof def.from !== "string") {
		// Backfill Join
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
	} else {
		const type = def.from
		const records = db
			.subspace([type, "primary"])
			.list()
			.map((i) => i.value)
		for (const r of records) {
			if (def.aggregate) {
				updateAggregationIndex(db, indexName, def, r, 1)
			} else {
				updateRecordIndex(db, schema, type, indexName, def, r, 1)
			}
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
