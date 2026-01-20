import { ListArgs, Tuple, TupleDb } from "../tupleDb/types"
import { Commit, CommitMeta, Op, ReducerMap } from "./types"

export type SyncDb<R extends ReducerMap> = {
	clock(): number
	history(range?: ListArgs<Tuple>): { key: Tuple; value: Commit }[]
	data: TupleDb
	apply(commit: CommitMeta & { ops: Op<R>[] }): void
}

export function syncDb<R extends ReducerMap>(db: TupleDb, reducers: R): SyncDb<R> {
	return {
		clock: () => (db.get(["clock"]) as number) || 0,

		history: (range) => db.subspace(["history"]).list(range),

		data: db.subspace(["data"]),

		apply: (commit) => {
			const clock = ((db.get(["clock"]) as number) || 0) + 1
			db.set(["clock"], clock)

			const finalCommit: Commit<R> = { ...commit, clock }
			db.set(["history", clock], finalCommit)

			const { ops, ...meta } = commit
			for (const op of ops) {
				const reducer = reducers[op.fn]
				if (!reducer) throw new Error(`Unknown operation: ${op.fn as string}`)
				reducer(db.subspace(["data"]), meta, ...op.args)
			}
		},
	}
}
