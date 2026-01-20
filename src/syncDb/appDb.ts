import { randomId } from "../shared/randomId"
import { ListArgs, Tuple, TupleDb } from "../tupleDb/types"
import { CommitArgs, CommitMeta, ReducerMap } from "./types"

export function appDb(db: TupleDb, reducers: ReducerMap) {
	return {
		list(path: Tuple, range: ListArgs<Tuple>) {
			const node = db.subspace(path)
			const clock = node.get(["clock"]) as number | undefined
			// Range can fetch from history or data subspaces!
			const data = node.list(range)
			return { clock, data }
		},

		write(commit: CommitArgs) {
			const commitedAt = new Date().toISOString()

			if (commit.id) {
				if (db.get(["_seen", commit.id])) return
				db.set(["_seen", commit.id], commitedAt)
			}

			const meta: CommitMeta = {
				id: commit.id || randomId(),
				commitedAt,
				authorId: commit.authorId,
				createdAt: commit.createdAt,
			}

			for (const op of commit.ops) {
				const reducer = reducers[op.fn]
				if (!reducer) throw new Error(`Unknown operation: ${op.fn}`)
				reducer(db, meta, ...op.args)
			}

		},
	}
}
