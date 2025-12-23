import { cloneDeep } from "lodash-es"
import { Tuple, TupleDb } from "./types"

// ============================================================================
// Types
// ============================================================================

export type TypeSchema = {
	primary: string[]
}

export type MatchNode = {
	from: string
	on?: { [key: string]: string }
}

export type MatchDef = {
	[alias: string]: MatchNode
}

export type WhereDef = {
	[field: string]: any
}

export type ReduceDef = {
	groupBy: string[]
	aggregate: { [alias: string]: { [op: string]: string } }
}

export type IndexDefinition = {
	match: MatchDef
	where?: WhereDef
	reduce?: ReduceDef
	sort?: string[]
}

export type Schema = {
	types: { [name: string]: TypeSchema }
	indexes: { [name: string]: IndexDefinition }
}

export type Query = IndexDefinition

export type Change = {
	type: string
	oldRecord: any | null
	newRecord: any | null
}

export type RecordDb = {
	createType: (name: string, def: TypeSchema) => void
	createIndex: (name: string, def: Query) => void
	deleteIndex: (q: Query) => void
	hasIndex: (q: Query) => string | false
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

	const types = db.subspace(["_schema", "types"]).list()
	for (const { key, value } of types) {
		schema.types[key[0] as string] = value as TypeSchema
	}

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

// ============================================================================
// Helpers & Public API
// ============================================================================

function hasIndex(schema: Schema, q: Query): string | false {
	const canonical = getCanonicalIndexName(q)
	if (schema.indexes[canonical]) return canonical
	return false
}

// ============================================================================
// Index Creation
// ============================================================================

function createAutoIndex(
	db: TupleDb,
	schema: Schema,
	q: Query
): { schema: Schema; indexName: string } {
	const indexName = getCanonicalIndexName(q)
	return createIndex(db, schema, indexName, q)
}

function createIndex(
	db: TupleDb,
	schema: Schema,
	indexName: string,
	def: IndexDefinition
): { schema: Schema; indexName: string } {
	if (schema.indexes[indexName]) {
		return { schema, indexName }
	}

	const newSchema = cloneDeep(schema)
	newSchema.indexes[indexName] = def

	saveIndex(db, indexName, def)
	ensureDependencies(db, newSchema, def)
	backfillIndex(db, newSchema, indexName)

	return { schema: newSchema, indexName }
}

function ensureDependencies(db: TupleDb, schema: Schema, def: IndexDefinition) {
	for (const [alias, node] of Object.entries(def.match)) {
		if (!node.on) continue
		const neededSort = Object.keys(node.on).sort()
		const depQuery: Query = {
			match: { t: { from: node.from } },
			sort: neededSort, // This will implicitly add PK at the end
		}
		const depName = getCanonicalIndexName(depQuery)
		if (!schema.indexes[depName]) {
			createIndex(db, schema, depName, depQuery)
		}
	}
}

function backfillIndex(db: TupleDb, schema: Schema, indexName: string) {
	const def = schema.indexes[indexName]
	const aliases = Object.keys(def.match)
	if (aliases.length === 0) return

	// Full join scan
	const results = executeMatch(db, schema, def.match, {})

	for (const row of results) {
		if (def.where && !matchWhere(row, def.where)) continue

		if (def.reduce) {
			updateAggregationState(db, schema, indexName, def, row, 1)
		} else {
			const sortKeys = (def.sort || []).map((path) => safeGet(row, path))
			const identity = getRowIdentityKey(schema, def.match, row)
			increment(db, [indexName, ...sortKeys, ...identity], 1)
		}
	}
}

// ============================================================================
// Write Path: View Maintenance
// ============================================================================

function updateIndexes(db: TupleDb, schema: Schema, change: Change) {
	const { type, oldRecord, newRecord } = change

	for (const [indexName, def] of Object.entries(schema.indexes)) {
		const relevantAliases: string[] = []
		for (const [alias, node] of Object.entries(def.match)) {
			if (node.from === type) relevantAliases.push(alias)
		}

		if (relevantAliases.length === 0) continue

		for (const alias of relevantAliases) {
			if (oldRecord) {
				propagateChange(db, schema, indexName, def, alias, oldRecord, -1)
			}
			if (newRecord) {
				propagateChange(db, schema, indexName, def, alias, newRecord, 1)
			}
		}
	}
}

function propagateChange(
	db: TupleDb,
	schema: Schema,
	indexName: string,
	def: IndexDefinition,
	alias: string,
	record: any,
	delta: number
) {
	const constraints: Record<string, any> = { [alias]: record }
	const rows = executeMatch(db, schema, def.match, constraints)

	for (const row of rows) {
		if (def.where && !matchWhere(row, def.where)) continue

		if (def.reduce) {
			updateAggregationState(db, schema, indexName, def, row, delta)
		} else {
			const sortKeys = (def.sort || []).map((path) => safeGet(row, path))
			const identity = getRowIdentityKey(schema, def.match, row)
			increment(db, [indexName, ...sortKeys, ...identity], delta)
		}
	}
}

function updateAggregationState(
	db: TupleDb,
	schema: Schema,
	indexName: string,
	def: IndexDefinition,
	row: any,
	delta: number
) {
	const groupBy = def.reduce!.groupBy
	const groupKey = groupBy.map((path) => safeGet(row, path))
	const stateKeyPrefix = ["_agg_state", indexName, ...groupKey]

	const oldStateRaw = db.get(stateKeyPrefix)
	const oldState = oldStateRaw ? (oldStateRaw as any) : {}

	const newState = cloneDeep(oldState)

	for (const [alias, aggDef] of Object.entries(def.reduce!.aggregate)) {
		const op = Object.keys(aggDef)[0]
		const fieldPath = aggDef[op]

		if (op === "count") {
			newState[alias] = (newState[alias] || 0) + delta
		} else if (op === "max") {
			const val = safeGet(row, fieldPath)
			// Key: [..., val, ...identity]
			const identity = getRowIdentityKey(schema, def.match, row)
			const valIndexKey = ["_agg_vals", indexName, alias, ...groupKey, val, ...identity]

			if (delta > 0) db.set(valIndexKey, 1)
			else db.delete(valIndexKey)

			// Find max
			const last = db
				.subspace(["_agg_vals", indexName, alias, ...groupKey])
				.list({ limit: 1, reverse: true })
			if (last.length > 0) {
				// Key relative to subspace is [val, ...identity]
				newState[alias] = last[0].key[0]
			} else {
				newState[alias] = null
			}
		}
	}

	db.set(stateKeyPrefix, newState)

	// Calculate "Payload" (Variables in Scope 2 but NOT in Sort)
	// Scope 2 = groupBy + aggregate aliases.
	const scope2Vars = [...groupBy, ...Object.keys(def.reduce!.aggregate)].sort()
	const sortVars = def.sort || []
	const payloadVars = scope2Vars.filter((v) => !sortVars.includes(v))

	// Helper to construct key part
	const makeKeyPart = (state: any, vars: string[]) => {
		return vars.map((path) => {
			if (state[path] !== undefined) return state[path]
			const groupIdx = groupBy.indexOf(path)
			if (groupIdx !== -1) return groupKey[groupIdx]
			return null
		})
	}

	// Remove Old
	if (oldStateRaw) {
		const oldSortKey = makeKeyPart(oldState, sortVars)
		const oldPayload = makeKeyPart(oldState, payloadVars)
		// We append GroupKey for uniqueness of SortKey if needed?
		// Actually, let's assume Payload + Sort covers Scope 2, which is unique per Group?
		// No, Scope 2 includes Aggregates, which change.
		// We need GroupKey to be unique.
		// If Sort + Payload doesn't include full GroupKey (possible?), we have an issue.
		// BUT payload includes all Scope2 - Sort.
		// Since Scope2 includes groupBy.
		// Then Sort + Payload includes ALL of groupBy.
		// So the key [Sort, Payload] includes the full GroupKey.
		// So it is unique per Group.

		increment(db, [indexName, ...oldSortKey, ...oldPayload], -1)
	}

	// Add New
	const hasData =
		Object.keys(newState).length > 0 && (newState.userCount === undefined || newState.userCount > 0)

	if (hasData) {
		const newSortKey = makeKeyPart(newState, sortVars)
		const newPayload = makeKeyPart(newState, payloadVars)
		increment(db, [indexName, ...newSortKey, ...newPayload], 1)
	}
}

// ============================================================================
// CSP / Match Solver
// ============================================================================

function executeMatch(
	db: TupleDb,
	schema: Schema,
	matchDef: MatchDef,
	constraints: Record<string, any>
): any[] {
	const aliases = Object.keys(matchDef)
	return solve(aliases, 0, { ...constraints })

	function solve(list: string[], idx: number, bound: Record<string, any>): any[] {
		if (!verifyConstraints(bound, matchDef)) return []

		if (idx >= list.length) {
			return [flattenRow(bound)]
		}

		const alias = list[idx]
		if (bound[alias]) {
			return solve(list, idx + 1, bound)
		}

		const def = matchDef[alias]
		const queryWhere: Record<string, any> = {}

		if (def.on) {
			for (const [myField, targetPath] of Object.entries(def.on)) {
				const [targetAlias, targetField] = targetPath.split(".")
				if (bound[targetAlias]) {
					queryWhere[myField] = bound[targetAlias][targetField]
				}
			}
		}

		const candidates = simpleQuery(db, schema, def.from, queryWhere)
		const results: any[] = []
		for (const cand of candidates) {
			const newBound = { ...bound, [alias]: cand }
			results.push(...solve(list, idx + 1, newBound))
		}
		return results
	}
}

function verifyConstraints(bound: Record<string, any>, matchDef: MatchDef): boolean {
	for (const [alias, rec] of Object.entries(bound)) {
		const def = matchDef[alias]
		if (!def.on) continue
		for (const [myField, targetPath] of Object.entries(def.on)) {
			const [targetAlias, targetField] = targetPath.split(".")
			if (bound[targetAlias]) {
				// Both sides bound, check equality
				if (rec[myField] !== bound[targetAlias][targetField]) return false
			}
		}
	}
	return true
}

function simpleQuery(db: TupleDb, schema: Schema, type: string, where: Record<string, any>): any[] {
	const typeDef = schema.types[type]

	if (typeDef.primary.every((k) => where[k] !== undefined)) {
		const pk = typeDef.primary.map((k) => where[k])
		const val = db.get([type, "primary", ...pk])
		return val ? [val] : []
	}

	for (const [name, def] of Object.entries(schema.indexes)) {
		if (!def.sort) continue
		const aliases = Object.keys(def.match)
		if (aliases.length !== 1) continue
		if (def.match[aliases[0]].from !== type) continue
		if (def.where) continue

		const sortKeys = def.sort
		const whereKeys = Object.keys(where)

		const prefix: any[] = []
		let covered = 0
		for (const k of sortKeys) {
			if (where[k] !== undefined) {
				prefix.push(where[k])
				covered++
			} else {
				break
			}
		}

		if (covered === whereKeys.length && covered > 0) {
			return db
				.subspace([name, ...prefix])
				.list()
				.map(({ key }) => {
					const pkLen = typeDef.primary.length
					const pkVals = key.slice(key.length - pkLen)
					return db.get([type, "primary", ...pkVals])
				})
				.filter((x) => x) as any[]
		}
	}

	const all = db
		.subspace([type, "primary"])
		.list()
		.map((x) => x.value)
	return all.filter((r) => matchWhere(r, where))
}

// ============================================================================
// Read Path: Execution
// ============================================================================

function processQuery(db: TupleDb, schema: Schema, q: Query): any[] {
	const existing = hasIndex(schema, q)

	if (existing) {
		const def = schema.indexes[existing]

		if (def.reduce) {
			return db
				.subspace([existing])
				.list()
				.map(({ key }) => {
					const obj: any = {}
					const sortFields = def.sort || []

					const groupBy = def.reduce!.groupBy
					const scope2Vars = [...groupBy, ...Object.keys(def.reduce!.aggregate)].sort()
					const payloadVars = scope2Vars.filter((v) => !sortFields.includes(v))

					let idx = 0

					// Extract Sort
					sortFields.forEach((f) => {
						obj[f] = key[idx++]
					})

					// Extract Payload
					payloadVars.forEach((f) => {
						obj[f] = key[idx++]
					})

					return obj
				})
		} else {
			// Flat Scan
			return db
				.subspace([existing])
				.list()
				.map(({ key }) => {
					const rowObj: any = {}
					const sortFields = def.sort || []

					key.slice(0, sortFields.length).forEach((val, i) => {
						rowObj[sortFields[i]] = val
					})

					const result: any = {}
					const aliases = Object.keys(def.match)

					for (const alias of aliases) {
						const idField = alias + ".id"
						if (rowObj[idField]) {
							const type = def.match[alias].from
							const rec = db.get([type, "primary", rowObj[idField]])
							if (rec) {
								for (const [k, v] of Object.entries(rec)) {
									result[alias + "." + k] = v
								}
							}
						}
					}

					Object.assign(result, rowObj)
					return result
				})
		}
	} else {
		const { indexName } = createAutoIndex(db, schema, q)
		return processQuery(db, loadSchema(db), q)
	}
}

// ============================================================================
// Utilities
// ============================================================================

function getCanonicalIndexName(def: IndexDefinition): string {
	const parts: string[] = ["v5"]

	const aliases = Object.keys(def.match).sort()
	parts.push("m")
	for (const a of aliases) {
		const m = def.match[a]
		parts.push(a, m.from)
		if (m.on) {
			const onKeys = Object.keys(m.on).sort()
			parts.push("on", ...onKeys.map((k) => `${k}-${m.on![k]}`))
		}
	}

	if (def.where) {
		parts.push("w")
		const keys = Object.keys(def.where).sort()
		for (const k of keys) {
			parts.push(k, JSON.stringify(def.where[k]))
		}
	}

	if (def.reduce) {
		parts.push("r")
		parts.push("g", ...def.reduce.groupBy.sort())
		const aggAliases = Object.keys(def.reduce.aggregate).sort()
		for (const a of aggAliases) {
			const agg = def.reduce.aggregate[a]
			const op = Object.keys(agg)[0]
			parts.push(a, op, agg[op])
		}
	}

	if (def.sort) {
		parts.push("s", ...def.sort)
	}

	return parts.join("_").replace(/[^a-zA-Z0-9_]/g, "")
}

function safeGet(obj: any, path: string) {
	const val = getPath(obj, path)
	return val === undefined ? null : val
}

function getPath(obj: any, path: string) {
	if (obj[path] !== undefined) return obj[path]
	const parts = path.split(".")
	if (parts.length === 2 && obj[parts[0]]) {
		return obj[parts[0]][parts[1]]
	}
	return undefined
}

function flattenRow(bound: Record<string, any>) {
	const res: any = {}
	for (const [alias, rec] of Object.entries(bound)) {
		for (const [k, v] of Object.entries(rec)) {
			res[`${alias}.${k}`] = v
		}
	}
	return res
}

function matchWhere(row: any, where: WhereDef): boolean {
	for (const [key, constraint] of Object.entries(where)) {
		const val = getPath(row, key)
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
}

function getRowIdentityKey(schema: Schema, match: MatchDef, row: any): any[] {
	const aliases = Object.keys(match).sort()
	const key: any[] = []
	for (const alias of aliases) {
		const type = match[alias].from
		const pkFields = schema.types[type].primary
		for (const f of pkFields) {
			const val = getPath(row, `${alias}.${f}`)
			if (val === undefined) throw new Error(`Missing PK ${alias}.${f} in row`)
			key.push(val)
		}
	}
	return key
}

function increment(db: TupleDb, key: Tuple, delta: number) {
	const curr = (db.get(key) as number) || 0
	const next = curr + delta
	if (next <= 0) db.delete(key)
	else db.set(key, next)
}

// ============================================================================
// RecordDb Factory
// ============================================================================

export function recordDb(db: TupleDb): RecordDb {
	const getSchema = () => loadSchema(db)

	return {
		createType: (name, def) => {
			saveType(db, name, def)
		},
		createIndex: (name, def) => {
			const schema = getSchema()
			createIndex(db, schema, name, def)
		},
		deleteIndex: (q) => {
			// Not impl
		},
		hasIndex: (q) => {
			const schema = getSchema()
			return hasIndex(schema, q)
		},
		get: (args) => {
			const schema = getSchema()
			const typeDef = schema.types[args.type]
			const pk = typeDef.primary.map((k) => args[k])
			return db.get([args.type, "primary", ...pk])
		},
		delete: (args) => {
			const schema = getSchema()
			const typeDef = schema.types[args.type]
			const pk = typeDef.primary.map((k) => args[k])
			const oldRecord = db.get([args.type, "primary", ...pk])
			if (!oldRecord) return

			db.delete([args.type, "primary", ...pk])
			updateIndexes(db, schema, { type: args.type, oldRecord, newRecord: null })
		},
		set: (record) => {
			const schema = getSchema()
			const { type } = record
			const typeDef = schema.types[type]
			const pk = typeDef.primary.map((k) => record[k])
			const oldRecord = db.get([type, "primary", ...pk])

			db.set([type, "primary", ...pk], record)
			updateIndexes(db, schema, { type, oldRecord, newRecord: record })
		},
		query: (q) => {
			const schema = getSchema()
			return processQuery(db, schema, q)
		},
	}
}
