import { tupleTx } from "../TupleDb"
import { TupleDb, Tuple, ListArgs } from "../types"
import { syncDb, ReducerMap, SyncHistoryEntry } from "../SyncDb"
import { SyncResult, ReadResult, WriteResult, FetchResult } from "./types"

export class SyncServer {
	constructor(
		public db: TupleDb,
		public reducers: ReducerMap
	) {}

	// Just submit writes, return confirmation (clock)
	write(scope: Tuple, ops: SyncHistoryEntry[]): WriteResult {
		const tx = tupleTx(this.db)
		let operationsApplied = false

		for (const entry of ops) {
			if (tx.get(["seen", entry.metadata.txId])) continue
			
			tx.set(["seen", entry.metadata.txId], Date.now())
			operationsApplied = true

			const scopeDb = syncDb(tx.subspace(scope), this.reducers, entry.metadata)
			const reducer = (scopeDb as any)[entry.op.fn]
			
			if (reducer) {
				reducer(...entry.op.args)
			} else {
				console.warn(`Unknown operation: ${entry.op.fn}`)
			}
		}

		if (operationsApplied) {
			tx.commit()
		}

		// Return current clock
		const scopeDb = syncDb(this.db.subspace(scope), this.reducers)
		return { clock: scopeDb.clock() }
	}

	// Fetch history updates since clock
	fetch(scope: Tuple, sinceClock: number): FetchResult {
		const scopeDb = syncDb(this.db.subspace(scope), this.reducers)
		const updates = scopeDb.history({ gt: [sinceClock] }).map(({ value }) => value)
		return {
			clock: scopeDb.clock(),
			updates
		}
	}

	// Composite: Write then Fetch
	sync(scope: Tuple, ops: SyncHistoryEntry[], syncedClock: number): SyncResult {
		this.write(scope, ops)
		return this.fetch(scope, syncedClock)
	}

	// Composite: Fetch updates and Read data snapshot
	read(scope: Tuple, range: ListArgs<Tuple>, syncedClock: number): ReadResult {
		const fetchRes = this.fetch(scope, syncedClock)
		const scopeDb = syncDb(this.db.subspace(scope), this.reducers)
		const data = scopeDb.list(range)

		return {
			...fetchRes,
			data
		}
	}
}