import { tupleTx } from "../TupleDb"
import { TupleDb, Tuple } from "../types"
import { syncDb, defaultReducers, ReducerMap } from "../SyncDb"
import { SyncPushRequest, SyncPushResponse } from "./types"

export class SyncServer {
	constructor(
		public db: TupleDb,
		public reducers: ReducerMap
	) {
		this.reducers = { ...defaultReducers, ...reducers }
	}

	push(scope: Tuple, req: SyncPushRequest): SyncPushResponse {
		const { ops, syncedClock } = req
		const tx = tupleTx(this.db)

		// 1. Apply new operations
		for (const entry of ops) {
			// Idempotency check
			if (tx.get(["seen", entry.metadata.txId])) continue

			tx.set(["seen", entry.metadata.txId], Date.now())

			// Use the semantic syncDb wrapper to execute and log history
			// We construct a syncDb for the requested scope
			// AND we pass the metadata from the client entry!
			const scopeDb = syncDb(tx.subspace(scope), this.reducers, entry.metadata)
			
			// We dynamically invoke the method corresponding to the op
			// This will:
			// 1. Log history (using the provided metadata)
			// 2. Call the reducer (writing to data subspace)
			const method = (scopeDb as any)[entry.op.fn]
			if (method) {
				method(...entry.op.args)
			} else {
				console.warn(`Unknown operation: ${entry.op.fn}`)
			}
		}

		tx.commit()

		// 2. Fetch updates
		const scopeDb = syncDb(this.db.subspace(scope), this.reducers)
		const history = scopeDb.history(syncedClock)
		const updates = history.map((h) => h.entry)

		return {
			serverClock: scopeDb.clock(),
			updates,
		}
	}
}
