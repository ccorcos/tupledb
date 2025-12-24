import { tupleTx } from "../TupleDb"
import { TupleDb } from "../types"
import { Operation, ReducerMap, SyncPushRequest, SyncPushResponse } from "./types"

export class SyncServer {
	constructor(
		public db: TupleDb,
		public reducers: ReducerMap
	) {}

	getClock(): number {
		return (this.db.get(["clock"]) as number) ?? 0
	}

	push(req: SyncPushRequest): SyncPushResponse {
		const { ops, syncedClock } = req
		const tx = tupleTx(this.db)
		let currentClock = (tx.get(["clock"]) as number) ?? 0

		// 1. Apply new operations
		for (const op of ops) {
			// Idempotency check
			// Use tupleTx so .get is available
			if (tx.get(["seen", op.id])) continue

			currentClock++
			tx.set(["clock"], currentClock)
			tx.set(["history", currentClock], op)
			tx.set(["seen", op.id], currentClock)

			const reducer = this.reducers[op.fn]
			if (!reducer) {
				console.warn(`Unknown reducer: ${op.fn}`)
				continue
			}

			// Execute the reducer on the transaction
			reducer(tx, ...op.args)
		}

		tx.commit()

		// 2. Fetch operations the client missed (rebase)
		// The client says they are at `syncedClock`.
		// We need to send back everything from `syncedClock + 1` to `currentClock`.
		const newOps: Operation[] = []
		// If the client is way behind, this could be huge.
		// Real implementations would paginate.
		// For now, we fetch all.
		const history = this.db.list({
			gt: ["history", syncedClock],
			lte: ["history", currentClock],
		})

		for (const { value } of history) {
			newOps.push(value as Operation)
		}

		return {
			serverClock: currentClock,
			newOps,
		}
	}
}
