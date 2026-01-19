import { randomId } from "../shared/randomId"
import { tupleTx } from "../tupleDb/TupleDb"
import { ListArgs, Tuple, TupleDb } from "../tupleDb/types"
import { PubsubServerApi } from "./PubSub"
import { Commit, CommitArgs, CommitMeta, Op, ReducerMap } from "./types"

export function pubsubQueue(db: TupleDb) {
	return {
		enqueue(timestamp: string, key: Tuple, value: any) {
			db.set(["_publish", timestamp, key], value)
		},
		dequeue() {
			const items = db.subspace(["_publish"]).list({ limit: 1000 })
			return {
				items: items.map(({ key, value }) => ({ key: key.at(-1) as Tuple, value })),
				clear() {
					db.subspace(["_publish"]).write({ delete: items.map(({ key }) => key) })
				},
			}
		},
	}
}

export function applySyncCommit(
	db: TupleDb,
	path: Tuple,
	reducers: ReducerMap,
	commit: CommitMeta & { ops: Op[] }
) {
	const node = db.subspace(path)

	const clock = ((node.get(["clock"]) as number) || 0) + 1
	node.set(["clock"], clock)

	const finalCommit: Commit = { ...commit, clock }
	node.set(["history", clock], finalCommit)

	const { ops, ...meta } = commit
	for (const op of ops) {
		const reducer = reducers[op.fn]
		if (!reducer) throw new Error(`Unknown operation: ${op.fn}`)
		reducer(node.subspace(["data"]), meta, ...op.args)
	}

	// commitedAt only exists on the server, not on the client.
	if (commit.commitedAt) {
		pubsubQueue(db).enqueue(commit.commitedAt, [...path, "clock"], clock)
	}
}

export function publish(db: TupleDb, pubsub: PubsubServerApi) {
	while (true) {
		const { items, clear } = pubsubQueue(db).dequeue()
		if (items.length === 0) break
		for (const { key, value } of items) pubsub.publish(key as any, value)
		clear()
	}
}

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
			const tx = tupleTx(db)

			const commitedAt = new Date().toISOString()

			if (commit.id) {
				if (tx.get(["_seen", commit.id])) return
				tx.set(["_seen", commit.id], commitedAt)
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
				reducer(tx, meta, ...op.args)
			}

			tx.commit()
		},
	}
}

export function syncServer(db: TupleDb, pubsub: PubsubServerApi, reducers: ReducerMap) {
	const app = appDb(db, reducers)
	const api = {
		list: app.list,
		write(args: CommitArgs) {
			app.write(args)
			publish(db, pubsub)
		},
	}
	return api
}
