import { ListArgs, Tuple, TupleDb, TupleTx } from "./types"

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

export type RecordListArgs = ListArgs<Tuple> & { prefix?: Tuple }

export type RecordDb = {
	get: (type: string, pkValues: Tuple) => any
	set: (record: any) => void
	delete: (type: string, pkValues: Tuple) => void
	getAggregation: (aggName: string, groupValues: Tuple) => number
	subspace: (prefix: Tuple) => {
		subspace: (next: Tuple) => any
		list: (args?: RecordListArgs) => any[]
	}
}

export function recordDb(db: TupleDb | TupleTx, schema: RecordSchema): RecordDb {
	function extractKey(obj: any, fields: string[]): Tuple {
		return fields.map((f) => obj[f])
	}

	function increment(key: Tuple, delta: number) {
		const current = (db.get(key) as number) || 0
		const next = current + delta
		if (next <= 0) {
			db.delete(key)
		} else {
			db.set(key, next)
		}
	}

	function get(type: string, pkValues: Tuple): any {
		return db.get([type, ...pkValues])
	}

	function getAggregation(aggName: string, groupValues: Tuple): number {
		const val = db.get(["aggregation", aggName, ...groupValues])
		return typeof val === "number" ? val : 0
	}

	function updateIndexes(type: string, typeSchema: TypeSchema, oldRecord: any, newRecord: any) {
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

	function triggerUpdates(type: string, oldRecord: any, newRecord: any) {
		if (schema.aggregations) {
			for (const [name, def] of Object.entries(schema.aggregations)) {
				if (def.source === type) {
					updateAggregation(name, def, oldRecord, newRecord)
				}
			}
		}
		if (schema.joins) {
			for (const [name, def] of Object.entries(schema.joins)) {
				updateJoin(name, def, oldRecord, newRecord)
			}
		}
	}

	function set(record: any) {
		const type = record.type
		const typeSchema = schema.types[type]
		if (!typeSchema) throw new Error(`Unknown type: ${type}`)

		const pkValues = extractKey(record, typeSchema.primary)
		const pk = [type, ...pkValues]
		const oldRecord = db.get(pk)

		// 1. Write Primary
		db.set(pk, record)

		// 2. Update Secondary Structures
		updateIndexes(type, typeSchema, oldRecord, record)
		triggerUpdates(type, oldRecord, record)
	}

	function del(type: string, pkValues: Tuple) {
		const typeSchema = schema.types[type]
		if (!typeSchema) throw new Error(`Unknown type: ${type}`)

		const pk = [type, ...pkValues]
		const oldRecord = db.get(pk)
		if (!oldRecord) return

		// 1. Delete Primary
		db.delete(pk)

		// 2. Update Secondary Structures
		updateIndexes(type, typeSchema, oldRecord, null)
		triggerUpdates(type, oldRecord, null)
	}

	function updateAggregation(
		aggName: string,
		aggDef: AggregationSchema,
		oldRecord: any,
		newRecord: any
	) {
		if (oldRecord) {
			const key = ["aggregation", aggName, ...extractKey(oldRecord, aggDef.groupBy)]
			increment(key, -1)
		}
		if (newRecord) {
			const key = ["aggregation", aggName, ...extractKey(newRecord, aggDef.groupBy)]
			increment(key, 1)
		}
	}

	function updateJoin(joinName: string, joinDef: JoinSchema, oldRecord: any, newRecord: any) {
		const sides: ("left" | "right")[] = ["left", "right"]
		for (const side of sides) {
			const mySideDef = joinDef[side]
			const otherSideDef = joinDef[side === "left" ? "right" : "left"]

			if (oldRecord?.type === mySideDef.type) {
				const matches = findMatches(otherSideDef, oldRecord[mySideDef.on])
				for (const match of matches) {
					const left = side === "left" ? oldRecord : match
					const right = side === "right" ? oldRecord : match
					updateJoinKey(joinName, joinDef, left, right, -1)
				}
			}

			if (newRecord?.type === mySideDef.type) {
				const matches = findMatches(otherSideDef, newRecord[mySideDef.on])
				for (const match of matches) {
					const left = side === "left" ? newRecord : match
					const right = side === "right" ? newRecord : match
					updateJoinKey(joinName, joinDef, left, right, 1)
				}
			}
		}
	}

	function findMatches(sideDef: JoinSide, matchVal: any): any[] {
		if (sideDef.index) {
			return scanIndex(sideDef.type, sideDef.index, { prefix: [matchVal] })
		}
		// Primary scan assumption: [type, matchVal, ...]
		return db
			.subspace([sideDef.type, matchVal])
			.list()
			.map((i) => i.value)
	}

	function updateJoinKey(
		joinName: string,
		joinDef: JoinSchema,
		left: any,
		right: any,
		delta: number
	) {
		const keyValues = joinDef.key.map(({ side, field }) =>
			side === "left" ? left[field] : right[field]
		)
		increment(["join", joinName, ...keyValues], delta)
	}

	function scanIndex(type: string, indexName: string, args: RecordListArgs = {}): any[] {
		const typeSchema = schema.types[type]
		if (!typeSchema) throw new Error(`Unknown type: ${type}`)

		const indexDef = typeSchema.indexes?.[indexName]
		if (!indexDef) throw new Error(`Unknown index: ${indexName}`)

		// Map PK fields to their position in the index definition
		const pkMapping = typeSchema.primary.map((pkField) => {
			const idx = indexDef.indexOf(pkField)
			if (idx === -1) throw new Error(`Index ${indexName} missing PK field ${pkField}`)
			return idx
		})

		const basePrefix = [type, indexName]
		const searchPrefix = args.prefix ? [...basePrefix, ...args.prefix] : basePrefix
		const { prefix, ...listArgs } = args

		return db
			.subspace(searchPrefix)
			.list(listArgs)
			.map(({ key }) => {
				const fullIndexValues = [...(args.prefix || []), ...key]
				const pkValues = pkMapping.map((idx) => fullIndexValues[idx])
				return get(type, pkValues)
			})
			.filter((x) => x !== undefined)
	}

	function subspace(prefix: Tuple) {
		return {
			subspace: (next: Tuple) => subspace([...prefix, ...next]),
			list: (args: RecordListArgs = {}) => {
				// Index scan magic: [type, indexName, ...]
				if (prefix.length >= 2) {
					const [type, indexName] = prefix
					if (
						typeof type === "string" &&
						typeof indexName === "string" &&
						schema.types[type]?.indexes?.[indexName]
					) {
						const extraPrefix = prefix.slice(2)
						const listPrefix = args.prefix ? [...extraPrefix, ...args.prefix] : extraPrefix
						return scanIndex(type, indexName, { ...args, prefix: listPrefix })
					}
				}

				const { prefix: listPrefix, ...listArgs } = args
				const target = listPrefix ? db.subspace([...prefix, ...listPrefix]) : db.subspace(prefix)
				return target.list(listArgs)
			},
		}
	}

	return {
		get,
		set,
		delete: del,
		getAggregation,
		subspace,
	}
}
