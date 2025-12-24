import { ReadOnlyTupleDb, TupleDb, Tuple, ListArgs, WriteArgs, JSONValue } from "./types"

export type SyncMetadata = {
	txId?: string
	authorId?: string
	timestamp?: number
}

export type Operation = {
	fn: string
	args: any[]
}

export type SyncHistoryEntry = {
	metadata: SyncMetadata
	op: Operation
}

export type Reducer<T = TupleDb> = (db: T, ...args: any[]) => void
export type ReducerMap = Record<string, Reducer<any>>

// Default reducers
const defaultReducers = {
	set: (db: TupleDb, key: Tuple, value: JSONValue) => db.set(key, value),
	delete: (db: TupleDb, key: Tuple) => db.delete(key),
}

type Tail<T extends any[]> = T extends [any, ...infer Rest] ? Rest : never

// SyncDb type definition
export type SyncDb<R extends ReducerMap> = ReadOnlyTupleDb & {
	[K in keyof R]: (...args: Tail<Parameters<R[K]>>) => void
} & {
	clock: () => number
	history: (args?: ListArgs<Tuple>) => { key: Tuple; value: SyncHistoryEntry }[]
}

export function syncDb<R extends ReducerMap>(
	db: TupleDb,
	reducers?: R,
	defaultMetadata: SyncMetadata = {}
): SyncDb<R> {
	const dataSpace = db.subspace(["data"])
	const historySpace = db.subspace(["history"])

	// Use provided reducers or default set/delete if none provided
	const effectiveReducers = (reducers || defaultReducers) as any

	const wrapper: any = {
		// ReadOnlyTupleDb methods
		get: (key: Tuple) => dataSpace.get(key),
		has: (key: Tuple) => dataSpace.has(key),
		list: (args?: ListArgs<Tuple>) => dataSpace.list(args),
		compare: db.compare,
		subspace: (prefix: Tuple) => dataSpace.subspace(prefix), // Reduced to ReadOnly view of data

		// Sync specific methods
		clock: () => (db.get(["clock"]) as number) ?? 0,
		history: (args?: ListArgs<Tuple>) => {
			// Proxy to history subspace
			return historySpace.list(args) as { key: Tuple; value: SyncHistoryEntry }[]
		},
	}

	// Bind Reducers
	for (const [name, fn] of Object.entries(effectiveReducers)) {
		wrapper[name] = (...args: any[]) => {
			const clock = (db.get(["clock"]) as number) ?? 0
			const entry: SyncHistoryEntry = {
				metadata: defaultMetadata,
				op: { fn: name, args },
			}
			
			// Log history
			db.set(["history", clock + 1], entry)
			// Increment clock
			db.set(["clock"], clock + 1)
			
			// Execute reducer on data subspace
			const contextSpace = Object.create(dataSpace)
			contextSpace.syncMetadata = entry.metadata
			;(fn as Function)(contextSpace, ...args)
		}
	}

	return wrapper as SyncDb<R>
}