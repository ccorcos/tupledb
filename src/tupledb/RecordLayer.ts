import { compactObj } from "shared/compactObj"
import { ListArgs, Tuple, TupleDb } from "./types"

export type TypeSchema = {
	primary: string[]
	indexes?: { [name: string]: string[] }
}

export type AggregationSchema = {
	source: string
	groupBy: string[]
	kind: "count"
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

export type RecordSchema = {
	types: { [type: string]: TypeSchema }
	aggregations?: { [name: string]: AggregationSchema }
	joins?: { [name: string]: JoinSchema }
}

export type RecordDb = {
	// Args here contain primary key properties.
	get: (args: { type: string; [key: string]: any }) => any | undefined
	delete: (args: { type: string; [key: string]: any }) => void

	// These ares are the entire record.
	set: (record: { type: string; [key: string]: any }) => void

	// Use the schema to layout the keys appropriately
	aggregation: (name: string, args: { [key: string]: any }) => number

	// Scan the index and use the schema to unroll ListArgs into a tuple with the appropriate key ordering.
	index: (
		type: string,
		name: string,
		args: ListArgs<{ [key: string]: any }> & { prefix?: { [key: string]: any } }
	) => any[]

	join: (
		name: string,
		args: ListArgs<{ [key: string]: any }> & { prefix?: { [key: string]: any } }
	) => { [key: string]: any }[]
}

/** Throws error on failed extraction. */
function extractKey(obj: any, fields: string[]): Tuple {
	return fields.map((f) => {
		if (obj[f] === undefined) throw new Error(`Missing key field: ${f}`)
		return obj[f]
	})
}

/** Similar to extractKey but can stop early. */
function unrollKey(obj: any, fields: string[]): Tuple {
	const result: Tuple = []
	if (!obj) return result
	for (const field of fields) {
		if (field in obj) result.push(obj[field])
		else break
	}
	return result
}

function increment(db: TupleDb, key: Tuple, delta: number) {
	const current = (db.get(key) as number) || 0
	const next = current + delta
	if (next <= 0) {
		db.delete(key)
	} else {
		db.set(key, next)
	}
}

function getRecord(
	db: TupleDb,
	schema: RecordSchema,
	args: { type: string; [key: string]: any }
): any {
	const { type } = args
	const typeSchema = schema.types[type]
	if (!typeSchema) throw new Error(`Unknown type: ${type}`)
	const primaryKey = extractKey(args, typeSchema.primary)
	return db.get([type, ...primaryKey])
}

function updateIndexes(
	db: TupleDb,
	type: string,
	typeSchema: TypeSchema,
	oldRecord: any,
	newRecord: any
) {
	if (!typeSchema.indexes) return
	for (const [indexName, fields] of Object.entries(typeSchema.indexes)) {
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

function updateAggregation(
	db: TupleDb,
	aggName: string,
	aggDef: AggregationSchema,
	oldRecord: any,
	newRecord: any
) {
	if (oldRecord) {
		const key = ["aggregation", aggName, ...extractKey(oldRecord, aggDef.groupBy)]
		increment(db, key, -1)
	}
	if (newRecord) {
		const key = ["aggregation", aggName, ...extractKey(newRecord, aggDef.groupBy)]
		increment(db, key, 1)
	}
}

function updateJoinKey(
	db: TupleDb,
	joinName: string,
	joinDef: JoinSchema,
	left: any,
	right: any,
	delta: number
) {
	const keyValues = joinDef.key.map(({ side, field }) =>
		side === "left" ? left[field] : right[field]
	)
	increment(db, ["join", joinName, ...keyValues], delta)
}

function scanIndex(
	db: TupleDb,
	schema: RecordSchema,
	type: string,
	indexName: string,
	args: ListArgs<{ [key: string]: any }>
): any[] {
	const typeSchema = schema.types[type]
	if (!typeSchema) throw new Error(`Unknown type: ${type}`)

	const indexDef = typeSchema.indexes?.[indexName]
	if (!indexDef) throw new Error(`Unknown index: ${indexName}`)

	// Map primary key fields to their position in the index definition
	const primaryKeyIndex = typeSchema.primary.map((pkField) => {
		const idx = indexDef.indexOf(pkField)
		if (idx === -1) throw new Error(`Index ${indexName} missing PK field ${pkField}`)
		return idx
	})

	const listArgs: ListArgs<Tuple> = compactObj({
		limit: args.limit,
		reverse: args.reverse,
		gt: args.gt ? unrollKey(args.gt, indexDef) : undefined,
		gte: args.gte ? unrollKey(args.gte, indexDef) : undefined,
		lt: args.lt ? unrollKey(args.lt, indexDef) : undefined,
		lte: args.lte ? unrollKey(args.lte, indexDef) : undefined,
	})

	return db
		.subspace([type, indexName])
		.list(listArgs)
		.map(({ key }) => {
			const primaryKey = primaryKeyIndex.map((idx) => key[idx])
			return db.get([type, ...primaryKey])
		})
}

function findMatches(db: TupleDb, schema: RecordSchema, sideDef: JoinSide, matchVal: any): any[] {
	if (sideDef.index) {
		return scanIndex(db, schema, sideDef.type, sideDef.index, {
			gte: { [sideDef.on]: matchVal },
			lte: { [sideDef.on]: matchVal },
		})
	}
	// Primary scan assumption: [type, matchVal, ...]
	return db
		.subspace([sideDef.type, matchVal])
		.list()
		.map((i) => i.value)
}

function updateJoin(
	db: TupleDb,
	schema: RecordSchema,
	joinName: string,
	joinDef: JoinSchema,
	oldRecord: any,
	newRecord: any
) {
	const sides: ("left" | "right")[] = ["left", "right"]
	for (const side of sides) {
		const mySideDef = joinDef[side]
		const otherSideDef = joinDef[side === "left" ? "right" : "left"]

		if (oldRecord?.type === mySideDef.type) {
			const matches = findMatches(db, schema, otherSideDef, oldRecord[mySideDef.on])
			for (const match of matches) {
				const left = side === "left" ? oldRecord : match
				const right = side === "right" ? oldRecord : match
				updateJoinKey(db, joinName, joinDef, left, right, -1)
			}
		}

		if (newRecord?.type === mySideDef.type) {
			const matches = findMatches(db, schema, otherSideDef, newRecord[mySideDef.on])
			for (const match of matches) {
				const left = side === "left" ? newRecord : match
				const right = side === "right" ? newRecord : match
				updateJoinKey(db, joinName, joinDef, left, right, 1)
			}
		}
	}
}

function triggerUpdates(
	db: TupleDb,
	schema: RecordSchema,
	type: string,
	oldRecord: any,
	newRecord: any
) {
	if (schema.aggregations) {
		for (const [name, def] of Object.entries(schema.aggregations)) {
			if (def.source === type) {
				updateAggregation(db, name, def, oldRecord, newRecord)
			}
		}
	}
	if (schema.joins) {
		for (const [name, def] of Object.entries(schema.joins)) {
			updateJoin(db, schema, name, def, oldRecord, newRecord)
		}
	}
}

function setRecord(db: TupleDb, schema: RecordSchema, record: any) {
	const type = record.type
	const typeSchema = schema.types[type]
	if (!typeSchema) throw new Error(`Unknown type: ${type}`)

	const pkValues = extractKey(record, typeSchema.primary)
	const pk = [type, ...pkValues]
	const oldRecord = db.get(pk)

	// 1. Write Primary
	db.set(pk, record)

	// 2. Update Secondary Structures
	updateIndexes(db, type, typeSchema, oldRecord, record)
	triggerUpdates(db, schema, type, oldRecord, record)
}

function deleteRecord(
	db: TupleDb,
	schema: RecordSchema,
	args: { type: string; [key: string]: any }
) {
	const { type } = args
	const typeSchema = schema.types[type]
	if (!typeSchema) throw new Error(`Unknown type: ${type}`)

	const pkValues = extractKey(args, typeSchema.primary)
	const pk = [type, ...pkValues]
	const oldRecord = db.get(pk)
	if (!oldRecord) return

	// 1. Delete Primary
	db.delete(pk)

	// 2. Update Secondary Structures
	updateIndexes(db, type, typeSchema, oldRecord, null)
	triggerUpdates(db, schema, type, oldRecord, null)
}

function getAggregation(
	db: TupleDb,
	schema: RecordSchema,
	aggName: string,
	args: { [key: string]: any }
): number {
	const aggDef = schema.aggregations?.[aggName]
	if (!aggDef) throw new Error(`Unknown aggregation: ${aggName}`)
	const groupValues = extractKey(args, aggDef.groupBy)
	const val = db.get(["aggregation", aggName, ...groupValues])
	return typeof val === "number" ? val : 0
}

function scanJoin(
	db: TupleDb,
	schema: RecordSchema,
	name: string,
	args: ListArgs<{ [key: string]: any }>
): { [key: string]: any }[] {
	const joinDef = schema.joins?.[name]
	if (!joinDef) throw new Error(`Unknown join: ${name}`)

	const keyFields = joinDef.key.map((k) => k.field)

	const listArgs: ListArgs<Tuple> = compactObj({
		limit: args.limit,
		reverse: args.reverse,
		gt: args.gt ? unrollKey(args.gt, keyFields) : undefined,
		gte: args.gte ? unrollKey(args.gte, keyFields) : undefined,
		lt: args.lt ? unrollKey(args.lt, keyFields) : undefined,
		lte: args.lte ? unrollKey(args.lte, keyFields) : undefined,
	})

	return db
		.subspace(["join", name])
		.list(listArgs)
		.filter((item) => (item.value as number) > 0)
		.map(({ key }) => {
			const obj: any = {}
			for (const [i, f] of keyFields.entries()) obj[f] = key[i]
			return obj
		})
}

export function recordDb(db: TupleDb, schema: RecordSchema): RecordDb {
	return {
		get: (args) => getRecord(db, schema, args),
		set: (record) => setRecord(db, schema, record),
		delete: (args) => deleteRecord(db, schema, args),
		aggregation: (name, args) => getAggregation(db, schema, name, args),
		index: (type, name, args) => scanIndex(db, schema, type, name, args),
		join: (name, args) => scanJoin(db, schema, name, args),
	}
}
