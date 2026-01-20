import { ListArgs, Tuple, TupleDb } from "../tupleDb/types"
import { Commit, CommitMeta, Op, ReducerMap } from "./types"

export type SyncDb = {
	clock(): number
	history(range?: ListArgs<Tuple>): { key: Tuple; value: Commit }[]
	data: TupleDb
	apply(commit: CommitMeta & { ops: Op[] }): void
}

export function syncDb(db: TupleDb, reducers: ReducerMap): SyncDb {
	return {
		clock: () => (db.get(["clock"]) as number) || 0,

		history: (range) => db.subspace(["history"]).list(range),

		data: db.subspace(["data"]),

		apply: (commit) => {
			const clock = ((db.get(["clock"]) as number) || 0) + 1
			db.set(["clock"], clock)

			const finalCommit: Commit = { ...commit, clock }
			db.set(["history", clock], finalCommit)

			const { ops, ...meta } = commit
			for (const op of ops) {
				const reducer = reducers[op.fn]
				if (!reducer) throw new Error(`Unknown operation: ${op.fn}`)
				reducer(db.subspace(["data"]), meta, ...op.args)
			}
		},
	}
}
