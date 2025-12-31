import { readOnlyTupleDb, tupleTx } from "tupleDb/TupleDb"
import { randomId } from "../shared/randomId"
import { Tuple, TupleDb } from "../tupleDb/types"
import { Commit, CommitArgs, ReducerMap, SyncDb } from "./types"

// Default reducers
export const defaultReducers = {
	set: (db: TupleDb, { key, value }: { key: Tuple; value: any }) => db.set(key, value),
	delete: (db: TupleDb, key: Tuple) => db.delete(key),
}

export function syncDb<R extends ReducerMap>(db: TupleDb): SyncDb<typeof defaultReducers>
export function syncDb<R extends ReducerMap>(db: TupleDb, reducers: R): SyncDb<R>
export function syncDb<R extends ReducerMap>(db: TupleDb, reducers?: R | undefined): SyncDb<R> {
	if (!reducers) reducers = defaultReducers as any

	const write = (args: CommitArgs<R> | Commit<R>): Commit<R> => {
		// TODO: should this not be in a transaction?
		const tx = tupleTx(db)

		const clock = (tx.get(["clock"]) as number) ?? 0

		let commit: Commit<R>

		// Check if it's a full Commit (Replication) or New Commit (Local)
		if ("clock" in args && typeof args.clock === "number") {
			const nextClock = clock + 1
			if (args.clock !== nextClock) {
				throw new Error(`Clock mismatch. Expected ${nextClock}, got ${args.clock}`)
			}
			// TODO: more validation.
			commit = args as Commit<R>
		} else {
			const nextClock = clock + 1
			const now = new Date().toISOString()
			commit = {
				id: args.id || randomId(),
				authorId: args.authorId,
				createdAt: args.createdAt || now,
				clock: nextClock,
				commitedAt: now,
				ops: args.ops,
			}
		}

		// Write to history
		tx.set(["history", commit.clock], commit)
		tx.set(["clock"], commit.clock)

		// Apply ops
		for (const op of commit.ops) {
			const fn = reducers![op.fn]
			if (!fn) throw new Error(`Unknown reducer: ${op.fn as string}`)
			fn(tx.subspace(["data"]), op.args)
		}

		tx.commit()

		return commit
	}

	// const writeMethods: any = {}
	// for (const name in reducers) {
	// 	writeMethods[name] = (args: any) => write({ ops: [{ fn: name, args }] })
	// }

	const instance = {
		clock: () => (db.get(["clock"]) as number) ?? 0,
		write,
		history: readOnlyTupleDb(db.subspace(["history"])),
		data: readOnlyTupleDb(db.subspace(["data"])),
	} as SyncDb<R>

	return instance

	// return { ...writeMethods, ...instance } as SyncDb<R>
}
