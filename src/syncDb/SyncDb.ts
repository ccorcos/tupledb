import { randomId } from "../shared/randomId"
import { ListArgs, ReadOnlyTupleDb, Tuple, TupleDb } from "../tupleDb/types"
import { Commit, SyncDb, ReducerMap, WriteSyncDb } from "./types"

// Default reducers
export const defaultReducers = {
	set: (db: TupleDb, { key, value }: { key: Tuple; value: any }) => db.set(key, value),
	delete: (db: TupleDb, key: Tuple) => db.delete(key),
	write: (db: TupleDb, args: any) => db.write(args),
}

export function syncDb<R extends ReducerMap>(
	db: TupleDb,
	reducers?: R,
	defaultMetadata: Partial<Commit> = {}
): SyncDb<R> {
	const dataSpace = db.subspace(["data"])
	const historySpace = db.subspace(["history"])

	const effectiveReducers = { ...defaultReducers, ...reducers } as unknown as R

	const dataWrapper = {
		// ReadOnlyTupleDb methods
		get: (key: Tuple) => dataSpace.get(key),
		has: (key: Tuple) => dataSpace.has(key),
		list: (args?: ListArgs<Tuple>) => dataSpace.list(args),
		compare: db.compare,
		subspace: (prefix: Tuple) => {
			// Read-only subspace
			const sub = dataSpace.subspace(prefix)
			return {
				get: sub.get,
				has: sub.has,
				list: sub.list,
				compare: sub.compare,
				subspace: sub.subspace,
			}
		},
	} as ReadOnlyTupleDb & WriteSyncDb<R>

	// Bind Reducers
	for (const [name, fn] of Object.entries(effectiveReducers)) {
		(dataWrapper as any)[name] = (args: any) => {
			const clock = (db.get(["clock"]) as number) ?? 0
			const nextClock = clock + 1
			const now = new Date().toISOString()

			const commit: Commit = {
				id: defaultMetadata.id || randomId(),
				authorId: defaultMetadata.authorId,
				createdAt: defaultMetadata.createdAt || now,
				clock: nextClock,
				commitedAt: now,
				ops: [{ fn: name, args }],
			}

			// Log history
			db.set(["history", nextClock], commit)
			// Increment clock
			db.set(["clock"], nextClock)

			// Execute reducer on data subspace
			// We pass dataSpace as 'tx' to the reducer
			const context = Object.create(dataSpace)
			context.syncMetadata = commit
			;(fn as Function)(context, args)
		}
	}

	// History Wrapper (ReadOnly)
	const historyWrapper: ReadOnlyTupleDb = {
		get: (key: Tuple) => historySpace.get(key),
		has: (key: Tuple) => historySpace.has(key),
		list: (args?: ListArgs<Tuple>) => historySpace.list(args),
		compare: db.compare,
		subspace: (prefix: Tuple) => historySpace.subspace(prefix) as any, // Cast because subspace returns TupleDb but we want ReadOnly
	}

	return {
		clock: () => (db.get(["clock"]) as number) ?? 0,
		history: historyWrapper,
		data: dataWrapper,
	}
}