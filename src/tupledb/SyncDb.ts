import { KeyEncodeWrite, TupleSubspaceEncoder } from "./Encoder"
import { JSONValue, ListArgs, Tuple, TupleDb, WriteArgs } from "./types"

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

// Reducers receive the raw storage (data subspace) as the first argument
export type Reducer<T = TupleDb> = (db: T, ...args: any[]) => void
export type ReducerMap = Record<string, Reducer<any>>

// Default reducers for raw access
export const defaultReducers = {
	set: (db: TupleDb, key: Tuple, value: JSONValue) => db.set(key, value),
	delete: (db: TupleDb, key: Tuple) => db.delete(key),
	write: (db: TupleDb, args: WriteArgs<Tuple, JSONValue>) => db.write(args),
}

// Helper type to strip the first argument
type Tail<T extends any[]> = T extends [any, ...infer Rest] ? Rest : never

export type SyncDb<R extends ReducerMap> = Omit<TupleDb, "subspace"> & {
	// Dynamic methods from reducers
	[K in keyof R]: (...args: Tail<Parameters<R[K]>>) => void
} & {
	clock: () => number
	history: (since?: number, limit?: number) => { clock: number; entry: SyncHistoryEntry }[]
	subspace: (prefix: Tuple) => SyncDb<R>
}

export function writeSyncOp(
	db: TupleDb,
	fn: string,
	args: any[],
	metadata: SyncMetadata = {},
	executor: (db: TupleDb) => void
) {
	// 1. Get the current clock
	const clock = (db.get(["clock"]) as number) ?? 0

	// 2. Write the operation to the history log
	const entry: SyncHistoryEntry = {
		metadata,
		op: { fn, args },
	}
	db.set(["history", clock + 1], entry)

	// 3. Increment the clock
	db.set(["clock"], clock + 1)

	// 4. Execute the operation on the "data" subspace
	// We pass the data subspace to the executor so it can write without logging history again
	const dataSpace = db.subspace(["data"])
	executor(dataSpace)
}

export function syncDb<R extends ReducerMap>(
	db: TupleDb, 
	reducers?: R, 
	defaultMetadata: SyncMetadata = {}
): SyncDb<R> {
	const dataSpace = db.subspace(["data"])
	const historySpace = db.subspace(["history"])
	
	const allReducers = { ...defaultReducers, ...reducers } as any

	// Create the proxy object
	// We start with a base object that implements Okv/TupleDb read methods strictly on dataSpace
	const wrapper: any = {
		// Read methods proxy to dataSpace
		get: (key: Tuple) => dataSpace.get(key),
		list: (args?: ListArgs<Tuple>) => dataSpace.list(args),
		clock: () => (db.get(["clock"]) as number) ?? 0,
		history: (since = 0, limit?: number) => {
			const entries = historySpace.list({ gt: [since], limit })
			return entries.map(({ key, value }) => ({
				clock: key[0] as number,
				entry: value as SyncHistoryEntry,
			}))
		},
		subspace: (prefix: Tuple) => {
			// Subspacing a SyncDb returns a new SyncDb for that prefix
			// We share the same reducers? 
			// The user example had: `syncDb(tx.subspace(...), userReducers)`
			// So usually you create a new SyncDb.
			// But for convenience, we can return a subspace SyncDb with same reducers.
			return subspaceSyncDb(db, prefix, reducers, defaultMetadata)
		},
		compare: db.compare,
	}

	// Generate reducer methods
	for (const [name, fn] of Object.entries(allReducers)) {
		wrapper[name] = (...args: any[]) => {
			writeSyncOp(db, name, args, defaultMetadata, (tx) => {
				(fn as Function)(tx, ...args)
			})
		}
	}

	// Ensure standard TupleDb write methods (set, delete, write) are present.
	// If 'reducers' overrode them, they are already set.
	// If not, 'defaultReducers' provided them.
	// We don't need to do anything else because we merged defaultReducers.

	return wrapper as SyncDb<R>
}

function subspaceSyncDb<R extends ReducerMap>(
	rootDb: TupleDb, 
	prefix: Tuple, 
	reducers?: R,
	defaultMetadata: SyncMetadata = {}
): SyncDb<R> {
	// A subspace SyncDb is tricky because "history" and "clock" are usually at the root of the SyncDb.
	// If we use `rootDb.subspace(prefix)`, we get a DB scoped to that prefix.
	// `syncDb(scopedDb)` will create `[prefix, "clock"]` and `[prefix, "history"]` and `[prefix, "data"]`.
	// This seems correct for "nested" sync databases (like per-user DBs).
	
	// However, if we just want a "view" into a larger SyncDb but sharing the same clock...
	// The current implementation of `syncDb` assumes it OWNS the clock/history at the root of `db`.
	// So `subspaceSyncDb` should probably just call `syncDb` on the subspaced root.
	
	const scopedDb = rootDb.subspace(prefix)
	return syncDb(scopedDb, reducers, defaultMetadata)
}
