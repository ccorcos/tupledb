import { tupleTx } from "../tupleDb/TupleDb"
import { ListArgs, Tuple, TupleDb } from "../tupleDb/types"
import { defaultReducers, syncDb } from "./SyncDb"
import {
	Commit,
	FetchResult,
	ReadResult,
	ReducerMap,
	SyncApi,
	SyncResult,
	WriteResult,
} from "./types"

export function syncServer(db: TupleDb, reducers: ReducerMap): SyncApi {
	// Just submit writes, return confirmation (clock)
	async function write(scope: Tuple, commits: Commit[]): Promise<WriteResult> {
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
					reducer(dataTx, ...op.args)
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
	async function fetch(scope: Tuple, sinceClock: number): Promise<FetchResult> {
		const scopeDb = syncDb(db.subspace(scope), reducers)
		const updates = scopeDb.history.list({ gt: [sinceClock] }).map(({ value }) => value as Commit)
		return {
			clock: scopeDb.clock(),
			updates,
		}
	}

	// Composite: Write then Fetch
	async function sync(scope: Tuple, commits: Commit[], syncedClock: number): Promise<SyncResult> {
		await write(scope, commits)
		return fetch(scope, syncedClock)
	}

	// Composite: Fetch updates and Read data snapshot
	async function read(
		scope: Tuple,
		range: ListArgs<Tuple>,
		syncedClock: number
	): Promise<ReadResult> {
		const fetchRes = await fetch(scope, syncedClock)
		const scopeDb = syncDb(db.subspace(scope), reducers)
		const data = scopeDb.data.list(range)

		return {
			...fetchRes,
			data,
		}
	}

	return { write, fetch, sync, read }
}
