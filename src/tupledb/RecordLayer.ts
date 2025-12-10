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

export function recordDb(db: TupleDb | TupleTx, schema: RecordSchema) {
	function getPkPrefix(type: string): Tuple {
		return [type]
	}

	function getIndexPrefix(type: string, indexName: string): Tuple {
		return [type, indexName]
	}

	function extractKey(obj: any, fields: string[]): Tuple {
		return fields.map((f) => obj[f])
	}

	function get(type: string, pkValues: Tuple): any {
		const prefix = getPkPrefix(type)
		const key = [...prefix, ...pkValues]
		return db.get(key)
	}

	function getAggregation(aggName: string, groupValues: Tuple): number {
		const key = ["aggregation", aggName, ...groupValues]
		const val = db.get(key)
		if (typeof val === "number") return val
		return 0
	}

	function set(record: any) {
		const type = record.type
		const typeSchema = schema.types[type]
		if (!typeSchema) throw new Error(`Unknown type: ${type}`)

		const pkValues = extractKey(record, typeSchema.primary)
		const pk = [...getPkPrefix(type), ...pkValues]

		const oldRecord = db.get(pk)

		// 1. Write Primary
		db.set(pk, record)

		// 2. Handle Indexes
		if (typeSchema.indexes) {
			for (const [indexName, fields] of Object.entries(typeSchema.indexes)) {
				const indexPrefix = getIndexPrefix(type, indexName)

				if (oldRecord) {
					const oldIndexKeyValues = extractKey(oldRecord, fields)
					const oldIndexKey = [...indexPrefix, ...oldIndexKeyValues]
					db.delete(oldIndexKey)
				}

				const newIndexKeyValues = extractKey(record, fields)
				const newIndexKey = [...indexPrefix, ...newIndexKeyValues]
				db.set(newIndexKey, null)
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

		const pk = [...getPkPrefix(type), ...pkValues]
		const oldRecord = db.get(pk)

		if (!oldRecord) return

		// Delete primary
		db.delete(pk)

		// Delete indexes
		if (typeSchema.indexes) {
			for (const [indexName, fields] of Object.entries(typeSchema.indexes)) {
				const indexPrefix = getIndexPrefix(type, indexName)
				const oldIndexKeyValues = extractKey(oldRecord, fields)
				const oldIndexKey = [...indexPrefix, ...oldIndexKeyValues]
				db.delete(oldIndexKey)
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
		// Logic: if oldRecord existed, we need to decrement matches.
		// If newRecord exists, we need to increment matches.

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
		// If index is specified, use scan logic.
		if (sideDef.index) {
			// Reuse the scan logic.
			// The old logic was: this.scan(sideDef.type, sideDef.index, { prefix: [matchVal] })
			// We can use subspace(...).list(...) or a helper.
			// Let's use a helper `scanIndex` that `list` also uses.
			return scanIndex(sideDef.type, sideDef.index, { prefix: [matchVal] })
		}

		// If no index, assume Primary Key scan?
		// We can try scanning the primary store.
		// "The `on` field implies single value."
		// "If PK is `[col1, col2]`. And we scan `col1=matchVal`."

		const prefix = [sideDef.type, matchVal]
		const items = db.subspace(prefix).list()
		// Map back to records.
		// Since we scanned primary store, items values are the records!
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
		args: { prefix?: Tuple; limit?: number; reverse?: boolean } = {}
	): any[] {
		const typeSchema = schema.types[type]
		if (!typeSchema) throw new Error(`Unknown type: ${type}`)
		if (!typeSchema.indexes || !typeSchema.indexes[indexName])
			throw new Error(`Unknown index: ${indexName}`)

		const indexDef = typeSchema.indexes[indexName]
		const indexPrefix = getIndexPrefix(type, indexName)

		const searchPrefix = args.prefix ? [...indexPrefix, ...args.prefix] : indexPrefix

		const sub = db.subspace(searchPrefix)
		const items = sub.list({ limit: args.limit, reverse: args.reverse })

		const pkFields = typeSchema.primary
		const indexFieldPositions = new Map<string, number>()
		indexDef.forEach((f, i) => indexFieldPositions.set(f, i))

		const resultRecords: any[] = []

		for (const { key } of items) {
			const fullIndexValues = [...(args.prefix || []), ...key]

			const pkValues: any[] = []
			let foundAll = true
			for (const pkField of pkFields) {
				const idx = indexFieldPositions.get(pkField)
				if (idx === undefined) {
					foundAll = false
					break
				}
				pkValues.push(fullIndexValues[idx])
			}

			if (foundAll) {
				const record = get(type, pkValues)
				if (record) resultRecords.push(record)
			}
		}

		return resultRecords
	}

	function subspace(prefix: Tuple) {
		return {
			subspace: (next: Tuple) => subspace([...prefix, ...next]),
			list: (args: ListArgs<Tuple> = {}) => {
				// Check if this prefix corresponds to an index scan.
				// We expect [type, indexName, ...]
				if (prefix.length >= 2) {
					const [type, indexName] = prefix
					if (typeof type === "string" && typeof indexName === "string") {
						const typeSchema = schema.types[type]
						if (typeSchema && typeSchema.indexes && typeSchema.indexes[indexName]) {
							// It's an index scan!
							// The "args.prefix" passed to list needs to be appended to any extra parts of "prefix" beyond [type, indexName]
							const extraPrefix = prefix.slice(2)
							const listPrefix = args.prefix ? [...extraPrefix, ...args.prefix] : extraPrefix

							return scanIndex(type, indexName, { ...args, prefix: listPrefix })
						}
					}
				}

				// Otherwise, just a normal list on the underlying db subspace
				return db.subspace(prefix).list(args)
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