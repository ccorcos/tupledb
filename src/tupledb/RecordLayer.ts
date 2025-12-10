import { Tuple, TupleDb, TupleTx, ListArgs } from "./types"

export type TypeSchema = {
	primary: string[]
	indexes?: {
		[name: string]: string[]
	}
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
	types: {
		[type: string]: TypeSchema
	}
	aggregations?: {
		[name: string]: AggregationSchema
	}
	joins?: {
		[name: string]: JoinSchema
	}
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

	function get(type: string, pkValues: Tuple): any {
		return db.get([type, ...pkValues])
	}

	function getAggregation(aggName: string, groupValues: Tuple): number {
		const val = db.get(["aggregation", aggName, ...groupValues])
		if (typeof val === "number") return val
		return 0
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

		// 2. Handle Indexes
		if (typeSchema.indexes) {
			for (const [indexName, fields] of Object.entries(typeSchema.indexes)) {
				if (oldRecord) {
					const oldIndexKeyValues = extractKey(oldRecord, fields)
					db.delete([type, indexName, ...oldIndexKeyValues])
				}

				const newIndexKeyValues = extractKey(record, fields)
				db.set([type, indexName, ...newIndexKeyValues], null)
			}
		}

		// 3. Handle Aggregations
		if (schema.aggregations) {
			for (const [aggName, aggDef] of Object.entries(schema.aggregations)) {
				if (aggDef.source !== type) continue
				updateAggregation(aggName, aggDef, oldRecord, record)
			}
		}

		// 4. Handle Joins
		if (schema.joins) {
			for (const [joinName, joinDef] of Object.entries(schema.joins)) {
				updateJoin(joinName, joinDef, oldRecord, record)
			}
		}
	}

	function del(type: string, pkValues: Tuple) {
		const typeSchema = schema.types[type]
		if (!typeSchema) throw new Error(`Unknown type: ${type}`)

		const pk = [type, ...pkValues]
		const oldRecord = db.get(pk)

		if (!oldRecord) return

		// Delete primary
		db.delete(pk)

		// Delete indexes
		if (typeSchema.indexes) {
			for (const [indexName, fields] of Object.entries(typeSchema.indexes)) {
				const oldIndexKeyValues = extractKey(oldRecord, fields)
				db.delete([type, indexName, ...oldIndexKeyValues])
			}
		}

		// Update Aggregations
		if (schema.aggregations) {
			for (const [aggName, aggDef] of Object.entries(schema.aggregations)) {
				if (aggDef.source !== type) continue
				updateAggregation(aggName, aggDef, oldRecord, null)
			}
		}

		// Update Joins
		if (schema.joins) {
			for (const [joinName, joinDef] of Object.entries(schema.joins)) {
				updateJoin(joinName, joinDef, oldRecord, null)
			}
		}
	}

	function updateAggregation(
		aggName: string,
		aggDef: AggregationSchema,
		oldRecord: any,
		newRecord: any
	) {
		if (oldRecord) {
			const groupKeys = extractKey(oldRecord, aggDef.groupBy)
			const key = ["aggregation", aggName, ...groupKeys]
			const current = (db.get(key) as number) || 0
			const next = current - 1
			if (next <= 0) {
				db.delete(key)
			} else {
				db.set(key, next)
			}
		}

		if (newRecord) {
			const groupKeys = extractKey(newRecord, aggDef.groupBy)
			const key = ["aggregation", aggName, ...groupKeys]
			const current = (db.get(key) as number) || 0
			db.set(key, current + 1)
		}
	}

	function updateJoin(joinName: string, joinDef: JoinSchema, oldRecord: any, newRecord: any) {
		const sides: ("left" | "right")[] = ["left", "right"]
		for (const side of sides) {
			const mySideDef = joinDef[side]
			const otherSide = side === "left" ? "right" : "left"
			const otherSideDef = joinDef[otherSide]

			if (oldRecord && oldRecord.type === mySideDef.type) {
				const matchVal = oldRecord[mySideDef.on]
				const matches = findMatches(otherSideDef, matchVal)
				for (const match of matches) {
					const left = side === "left" ? oldRecord : match
					const right = side === "right" ? oldRecord : match
					updateJoinKey(joinName, joinDef, left, right, -1)
				}
			}

			if (newRecord && newRecord.type === mySideDef.type) {
				const matchVal = newRecord[mySideDef.on]
				const matches = findMatches(otherSideDef, matchVal)
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
		
		const prefix = [sideDef.type, matchVal]
		const items = db.subspace(prefix).list()
		return items.map((item) => item.value)
	}

	function updateJoinKey(
		joinName: string,
		joinDef: JoinSchema,
		left: any,
		right: any,
		delta: number
	) {
		const keyValues = joinDef.key.map(({ side, field }) => {
			return side === "left" ? left[field] : right[field]
		})
		const key = ["join", joinName, ...keyValues]
		const current = (db.get(key) as number) || 0
		const next = current + delta
		if (next <= 0) {
			db.delete(key)
		} else {
			db.set(key, next)
		}
	}

	function scanIndex(
		type: string,
		indexName: string,
		args: RecordListArgs = {}
	): any[] {
		const typeSchema = schema.types[type]
		if (!typeSchema) throw new Error(`Unknown type: ${type}`)
		
		const indexDef = typeSchema.indexes?.[indexName]
		if (!indexDef) throw new Error(`Unknown index: ${indexName}`)

		// Map PK fields to their position in the index definition
		const pkMapping = typeSchema.primary.map(pkField => {
			const idx = indexDef.indexOf(pkField)
			if (idx === -1) throw new Error(`Index ${indexName} missing PK field ${pkField}`)
			return idx
		})
		
		const basePrefix = [type, indexName]
		const searchPrefix = args.prefix ? [...basePrefix, ...args.prefix] : basePrefix

		// Filter out prefix from args before passing to db.list
		const { prefix, ...listArgs } = args
		const items = db.subspace(searchPrefix).list(listArgs)

		return items.map(({ key }) => {
			const fullIndexValues = [...(args.prefix || []), ...key]
			const pkValues = pkMapping.map(idx => fullIndexValues[idx])
			return get(type, pkValues)
		}).filter(x => x !== undefined)
	}

	function subspace(prefix: Tuple) {
		return {
			subspace: (next: Tuple) => subspace([...prefix, ...next]),
			list: (args: RecordListArgs = {}) => {
				// Check for index scan pattern [type, indexName, ...]
				if (prefix.length >= 2) {
					const [type, indexName] = prefix
					if (typeof type === "string" && typeof indexName === "string") {
						const typeSchema = schema.types[type]
						if (typeSchema && typeSchema.indexes && typeSchema.indexes[indexName]) {
							const extraPrefix = prefix.slice(2)
							const listPrefix = args.prefix ? [...extraPrefix, ...args.prefix] : extraPrefix
							return scanIndex(type, indexName, { ...args, prefix: listPrefix })
						}
					}
				}
				
				// Normal subspace list
				const { prefix: listPrefix, ...listArgs } = args
				const finalSub = listPrefix ? db.subspace([...prefix, ...listPrefix]) : db.subspace(prefix)
				return finalSub.list(listArgs)
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
