import { tupleTx } from "../TupleDb"
import { TupleDb, Tuple } from "../types"
import { syncDb } from "../SyncDb"
import { Operation, ReducerMap, SyncPushRequest, SyncPushResponse } from "./types"

export class SyncServer {
	constructor(
		public db: TupleDb,
		public reducers: ReducerMap
	) {}

	push(scope: Tuple, req: SyncPushRequest): SyncPushResponse {
		const { ops, syncedClock } = req
		const tx = tupleTx(this.db)

		// 1. Apply new operations
		for (const op of ops) {
			// Idempotency check
			// We use a global "seen" subspace to track operation IDs
			if (tx.get(["seen", op.id])) continue

			// Mark as seen
			// We store timestamp or just true
			tx.set(["seen", op.id], Date.now())

			const reducer = this.reducers[op.fn]
			if (!reducer) {
				console.warn(`Unknown reducer: ${op.fn}`)
				continue
			}

			// Wrap the transaction to inject metadata
			// This allows syncDb(tx) to pick up the txId automatically
			const contextTx = Object.create(tx)
			contextTx.syncMetadata = {
				txId: op.id,
				authorId: "todo", // We would extract this from auth context
				timestamp: op.timestamp,
			}

			// Execute the reducer on the context-aware transaction
			// The reducer is responsible for using `syncDb(tx.subspace(...))` to write changes
			reducer(contextTx, ...op.args)
		}

		tx.commit()

		// 2. Fetch updates the client missed (rebase)
		// We fetch history specifically for the requested scope
		const scopeDb = syncDb(this.db.subspace(scope))
		const history = scopeDb.history(syncedClock)
		const updates = history.map((h) => h.entry)

		return {
			serverClock: scopeDb.clock(),
			updates,
		}
	}
}