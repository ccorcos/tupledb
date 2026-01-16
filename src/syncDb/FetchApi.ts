import { ListArgs, Tuple, TupleDb } from "../tupleDb/types"
import { syncDb } from "./SyncDb"
import { Commit, FetchResult, ReadResult, ReducerMap } from "./types"

/**
 * The Fetch API for reading from syncDbs.
 * Clients use this to pull updates from individual scopes.
 */
export type FetchApi = {
	/** Fetch history updates since a given clock */
	fetch: (scope: Tuple, sinceClock: number) => Promise<FetchResult>
	/** Fetch updates and a data snapshot in one call */
	read: (scope: Tuple, range: ListArgs<Tuple>, syncedClock: number) => Promise<ReadResult>
}

/**
 * Creates a FetchApi for reading from syncDbs.
 *
 * @param db - The root TupleDb
 * @param reducers - Reducers for the syncDbs (needed for syncDb wrapper)
 */
export function createFetchApi(db: TupleDb, reducers: ReducerMap): FetchApi {
	return {
		fetch: async (scope, sinceClock) => {
			const scopeDb = syncDb(db.subspace(scope), reducers)
			const updates = scopeDb.history
				.list({ gt: [sinceClock] })
				.map(({ value }) => value as Commit)
			return {
				clock: scopeDb.clock(),
				updates,
			}
		},

		read: async (scope, range, syncedClock) => {
			const scopeDb = syncDb(db.subspace(scope), reducers)
			const updates = scopeDb.history
				.list({ gt: [syncedClock] })
				.map(({ value }) => value as Commit)
			const data = scopeDb.data.list(range)

			return {
				clock: scopeDb.clock(),
				updates,
				data,
			}
		},
	}
}
