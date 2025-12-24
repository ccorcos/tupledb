import { tupleTx } from "../tupledb/TupleDb"
import { TupleDb, Tuple, ListArgs } from "../tupledb/types"
import { syncDb, defaultReducers } from "./SyncDb"
import { SyncResult, ReadResult, WriteResult, FetchResult, SyncServer, ReducerMap, Commit } from "./types"

export function syncServer(db: TupleDb, reducers: ReducerMap): SyncServer {
	// Just submit writes, return confirmation (clock)
	function write(scope: Tuple, commits: Commit[]): WriteResult {
		const tx = tupleTx(db)
		const scopeTx = tx.subspace(scope)
		const dataTx = scopeTx.subspace(["data"])
		const historyTx = scopeTx.subspace(["history"])

		let operationsApplied = false

		for (const commit of commits) {
			if (tx.get(["seen", commit.id])) continue

			tx.set(["seen", commit.id], Date.now())
			operationsApplied = true

			const clock = (scopeTx.get(["clock"]) as number) ?? 0
			const nextClock = clock + 1

			const serverCommit: Commit = {
				...commit,
				clock: nextClock,
				commitedAt: new Date().toISOString(),
			}

			// Write history
			historyTx.set([nextClock], serverCommit)
			scopeTx.set(["clock"], nextClock)

			// Apply Ops
			for (const op of commit.ops) {
				const reducer = reducers[op.fn] || (defaultReducers as any)[op.fn]
				if (reducer) {
					const context = Object.create(dataTx)
					context.syncMetadata = serverCommit
					reducer(context, op.args)
				} else {
					console.warn(`Unknown operation: ${op.fn}`)
				}
			}
		}

		if (operationsApplied) {
			tx.commit()
		}

		// Return current clock
		const scopeDb = syncDb(db.subspace(scope), reducers)
		return { clock: scopeDb.clock() }
	}

	// Fetch history updates since clock
	function fetch(scope: Tuple, sinceClock: number): FetchResult {
		const scopeDb = syncDb(db.subspace(scope), reducers)
		const updates = scopeDb.history
			.list({ gt: [sinceClock] })
			.map(({ value }) => value as Commit)
		return {
			clock: scopeDb.clock(),
			updates,
		}
	}

	// Composite: Write then Fetch
	function sync(scope: Tuple, commits: Commit[], syncedClock: number): SyncResult {
		write(scope, commits)
		return fetch(scope, syncedClock)
	}

	// Composite: Fetch updates and Read data snapshot
	function read(scope: Tuple, range: ListArgs<Tuple>, syncedClock: number): ReadResult {
		const fetchRes = fetch(scope, syncedClock)
		const scopeDb = syncDb(db.subspace(scope), reducers)
		const data = scopeDb.data.list(range)

		return {
			...fetchRes,
			data,
		}
	}

	return { write, fetch, sync, read }
}
