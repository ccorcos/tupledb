import { randomId } from "../shared/randomId"
import { ListArgs, Tuple, TupleDb } from "../tupleDb/types"
import { CommitArgs, CommitMeta, Op, ReducerMap } from "./types"

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

			applyCommit(db, reducers, meta, commit.ops)


		},
	}
}


export function applyCommit<R extends ReducerMap>(
	db: TupleDb,
	reducers: R,
	meta: CommitMeta,
	ops: Op<R>[]
): void {
	for (const op of ops) {
		const reducer = reducers[op.fn as keyof R]
		if (!reducer) throw new Error(`Unknown operation: ${op.fn as string}`)
		reducer(db, meta, ...op.args)
	}
}
