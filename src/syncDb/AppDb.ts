import { tupleTx } from "../tupleDb/TupleDb"
import { Tuple, TupleDb } from "../tupleDb/types"

/**
 * A global operation at the AppDb level.
 * These are domain-specific operations that may dispatch to multiple SyncDbs internally.
 */
export type AppOp<R extends AppReducerMap = any> = {
	fn: keyof R
	args: any
}

/**
 * A reducer at the AppDb level.
 * Receives the root transaction and returns which scopes were affected.
 * The reducer is responsible for calling applyCommit on the appropriate scopes.
 */
export type AppReducer = (tx: TupleDb, args: any) => { affectedScopes: Tuple[] }

export type AppReducerMap = Record<string, AppReducer>

/**
 * Result of a write operation at the AppDb level.
 */
export type WriteResult = {
	affectedScopes: { scope: Tuple; clock: number }[]
}

/**
 * The AppDb interface.
 */
export type AppDb<R extends AppReducerMap = AppReducerMap> = {
	write: (txId: string, ops: AppOp<R>[]) => Promise<WriteResult>
}

export type AppDbOptions = {
	/** If provided, outbox entries are written transactionally for reliable publishing */
	outboxPrefix?: Tuple
}

/**
 * Creates an AppDb - the top-level write API.
 *
 * Features:
 * - Global idempotency via ["seen", txId]
 * - Domain-specific operations that can dispatch to multiple SyncDbs
 * - Transactional outbox for reliable publishing (optional)
 *
 * @param db - The root TupleDb
 * @param reducers - Domain-specific reducers
 * @param options - Configuration options
 */
export function createAppDb<R extends AppReducerMap>(
	db: TupleDb,
	reducers: R,
	options: AppDbOptions = {}
): AppDb<R> {
	return {
		write: async (txId, ops) => {
			const tx = tupleTx(db)

			// Idempotency check
			if (tx.get(["seen", txId])) {
				return { affectedScopes: [] }
			}
			tx.set(["seen", txId], Date.now())

			// Dispatch ops and collect affected scopes
			const affectedScopes: { scope: Tuple; clock: number }[] = []
			for (const op of ops) {
				const reducer = reducers[op.fn as keyof R]
				if (!reducer) {
					console.warn(`Unknown operation: ${String(op.fn)}`)
					continue
				}
				const result = reducer(tx, op.args)
				for (const scope of result.affectedScopes) {
					const clock = tx.subspace(scope).get(["clock"]) as number
					affectedScopes.push({ scope, clock })
				}
			}

			// Write outbox transactionally if configured
			if (options.outboxPrefix && affectedScopes.length > 0) {
				tx.set([...options.outboxPrefix, Date.now()], { scopes: affectedScopes })
			}

			tx.commit()
			return { affectedScopes }
		},
	}
}
