import { codec } from "tupleDb/Codec"
import { OkvCache } from "tupleDb/OkvCache"
import { TupleCache } from "tupleDb/TupleCache"
import { TupleCache as TupleCacheApi } from "tupleDb/types"
import { CommitArgs, CommitMeta, Op, OpsBuilder, Pubsub, ReducerMap, SyncApi } from "./types"

export class SyncClient<R extends ReducerMap> {
	cache: TupleCacheApi
	api: SyncApi
	pubsub: Pubsub
	reducers: R

	constructor(args: { api: SyncApi; pubsub: Pubsub; reducers: R }) {
		this.api = args.api
		this.pubsub = args.pubsub
		this.reducers = args.reducers
		this.cache = new TupleCache(new OkvCache(codec.compare))
	}

	pending: CommitArgs<R>[] = []
	write(meta: CommitMeta, build: (ops: OpsBuilder<R>) => void) {
		const ops: Op<R>[] = []
		const builder: any = {}
		for (const key in this.reducers) {
			builder[key] = (...fnArgs: any[]) => ops.push({ fn: key, args: fnArgs } as any)
		}
		build(builder)
		const commit: CommitArgs<R> = { ...meta, ops }
		// this.pending.push(commit)

		// TODO: optimistic apply
		for (const op of ops) {
			const reducer = this.reducers[op.fn]
			reducer(tx, ...op.args)
		}

		// need a finalize function in the commit.

		// Queue commit
		this.pending.push(commit)

		// What happens here...
		// - when the reducer fetches from the cache, it uses whatever it's got.
		// - when it creates a syncDb inside the reducer, that's going to end up in history... but i'd like it to end up as pending.
		// - when we sync with the server, we commit those changes.
		//
		// hmm. its possible we're trying to do something kind of impossible. how can we simply this?
		// i want syncdbs to be somewhat independent of each other. their own history, their own sync context, applying history.
		// and yet I also want some ability to transactionally write to multiple syncdbs at the same time. that's a single
		// commit that fans out to multiple syncdbs. on the frontend, that's just a single commit though but it ends up in
		// multiple histories...

		// You definitely need the fanout though. The clients don't have all the data, or permission.
		// * Fanning out a message to send is a perfect example. We need this top-level idea.
		// * Writing to two Notion blocks transactionally so that pointers line up is a different but relevant example.
		//
		//
	}
}
