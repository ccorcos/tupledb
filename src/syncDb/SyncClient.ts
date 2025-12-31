import { Cache, cachedRange } from "../tupleDb/Cache"
import { TupleCache } from "../tupleDb/TupleCache"
import { codec } from "../tupleDb/Codec"
import { readOnlyTupleDb, tupleTx } from "../tupleDb/TupleDb"
import { ListArgs, ReadOnlyTupleDb, Tuple, TupleTx, WriteArgs, ITupleCache } from "../tupleDb/types"
import { defaultReducers } from "./SyncDb"
import { Commit, JSONValue, Op, PendingCommit, Pubsub, ReducerMap, SubscribeResult, SyncApi, ISyncCache, IClientSyncDb } from "./types"
import { randomId } from "../shared/randomId"

export class SyncCache implements ISyncCache {
	cache: ITupleCache
	api: SyncApi
	pubsub: Pubsub
	// We cache ClientSyncDb instances to share state (like pending commits/clock) for the same prefix.
	sessions = new Map<string, ClientSyncDb<any>>()

	constructor(args: { api: SyncApi; pubsub: Pubsub }) {
		this.api = args.api
		this.pubsub = args.pubsub
		this.cache = new TupleCache(new Cache(codec.compare))
	}

	syncDb<R extends ReducerMap>(prefix: Tuple, reducers: R): ClientSyncDb<R> {
		const key = JSON.stringify(prefix)
		if (!this.sessions.has(key)) {
			this.sessions.set(key, new ClientSyncDb(this, prefix, reducers))
		}
		const session = this.sessions.get(key)!
		// If reducers changed, update them? Ideally they shouldn't change for the same prefix.
		// For now assume they are consistent.
		return session
	}
}

export class ClientSyncDb<R extends ReducerMap> implements IClientSyncDb<R> {
	pendingCommits: PendingCommit<R>[] = []
	syncedClock: number = 0

	cache: ITupleCache
	dataCache: ITupleCache

	constructor(
		public syncCache: SyncCache,
		public prefix: Tuple,
		public reducers: R
	) {
		this.cache = (syncCache.cache as ITupleCache).subspace(prefix)
		this.dataCache = this.cache.subspace(["data"])

		const clock = this.cache.listRaw({ gte: ["clock"], lte: ["clock"] })[0]?.value
		this.syncedClock = (clock as number) || 0
	}

	clock = () => this.syncedClock

	// ==========================================================================
	// Data API
	// ==========================================================================

	get data() {
		const self = this
		const db = readOnlyTupleDb({
			compare: this.dataCache.compare,
			list: (args) => this.dataCache.listRaw(args),
			get: (key) => this.dataCache.listRaw({ gte: key, lte: key })[0]?.value,
			has: (key) => this.dataCache.listRaw({ gte: key, lte: key }).length > 0,
			write: () => { throw new Error("Write via user.write()") }, // Read-only
			subspace: (p) => { throw new Error("Subspace not fully implemented on ClientSyncDb data") } // TODO
		} as any)

		return {
			...db,
			subscribe: (args: ListArgs<Tuple>, listener: (result: { hit?: any[]; miss?: boolean; prefix?: any[] }) => void): SubscribeResult => {
				return self.subscribeData(args, listener)
			}
		}
	}

	private subscribeData(args: ListArgs<Tuple>, listener: (result: { hit?: any[]; miss?: boolean; prefix?: any[] }) => void): SubscribeResult {
		// 1. Local Cache Subscription
		const cacheUnsub = this.dataCache.subscribe(cachedRange(args, []), () => {
			const res = this.dataCache.list(args)
			listener(res)
		})

		// 2. PubSub Subscription (Clock)
		const clockTuple = [...this.prefix, "clock"]
		// We subscribe to the clock. When it changes, we fetch updates.
		// NOTE: In a real app we might want to ref-count this subscription so we don't sync multiple times.
		// For now, each subscription triggers its own sync logic or we rely on the shared session state.
		// Ideally, the Session should manage the clock subscription.
		
		// Let's attach a listener to the session that triggers sync.
		const pubsubUnsub = this.syncCache.pubsub.onMessage((tuple, value) => {
			// Check if it matches our clock tuple
			if (codec.compare(tuple, clockTuple) === 0) {
				// New clock available.
				// Trigger sync.
				this.sync()
			}
		})
		this.syncCache.pubsub.subscribe(clockTuple)


		// 3. Initial Remote Fetch
		const remote = this.fetchAndApply(args).then((data) => {
			return data
		})

		// 4. Initial Local Result
		const initialRes = this.dataCache.list(args)
		
		return {
			local: initialRes,
			remote,
			unsubscribe: () => {
				cacheUnsub()
				pubsubUnsub()
				// Maybe unsubscribe from pubsub topic if no more listeners?
			}
		}
	}

	private async fetchAndApply(args: ListArgs<Tuple>) {
		try {
			// Determine range relative to dataPrefix
			// The API read expects "scope" (prefix) and "range" (relative args)
			const res = await this.syncCache.api.read(this.prefix, args, this.syncedClock)
			
			this.handleSyncResponse(res.clock, res.updates)
			
			// Insert the data snapshot into cache
			this.dataCache.insert(args, res.data)
			
			return res.data
		} catch (e) {
			console.error("Fetch failed", e)
			throw e
		}
	}


	// ==========================================================================
	// History API
	// ==========================================================================

	get history() {
		// Similar to data but for history subspace
		const historyCache = this.cache.subspace(["history"])
		
		// TODO: Implement read-only DB wrapper for history
		// For now just enough for tests/usage
		return {
			list: (args: ListArgs<Tuple> = {}) => {
				return historyCache.listRaw(args)
			},
			subscribe: () => {
				// TODO: Implement subscription for history
			}
		}
	}

	// ==========================================================================
	// Pending API
	// ==========================================================================

	get pending() {
		return {
			list: () => this.pendingCommits.map(p => ({ ...p.commit }))
		}
	}


	// ==========================================================================
	// Write API
	// ==========================================================================

	write(meta: any, build?: (ops: any) => void) {
		if (build === undefined) {
			// Overload: write(build)
			build = meta
			meta = {}
		}

		const ops: Op<R>[] = []
		const proxy = new Proxy({}, {
			get: (_, fn) => (...args: any[]) => ops.push({ fn: fn as string as keyof R & string, args: args as any })
		})
		build!(proxy)

		this.dispatch(meta, ops)
	}

	private dispatch(meta: any, ops: Op<R>[]) {
		const now = new Date().toISOString()
		const commit: Commit<R> = {
			id: randomId(),
			clock: 0, // Placeholder
			commitedAt: now,
			createdAt: now,
			ops,
			...meta
		}

		// Apply optimistically
		// Writes are relative to the session prefix
		const writes: WriteArgs<Tuple, JSONValue> = { set: [], delete: [] }
		
		// Create a proxy tx that writes to `writes` array
		// It acts on `["data"]`
		const proxyTx = this.createProxyTx(writes)

		for (const op of ops) {
			const reducer = this.reducers[op.fn as string] || (defaultReducers as any)[op.fn as string]
			if (!reducer) throw new Error(`Unknown reducer: ${op.fn as string}`)
			
			reducer(proxyTx, ...op.args)
		}

		const cleanup = this.cache.write(writes)

		this.pendingCommits.push({
			commit,
			cleanup,
			changes: writes
		})

		this.sync()
	}

	private createProxyTx(writes: WriteArgs<Tuple, JSONValue>, scope: Tuple = []): TupleTx {
		const fullPrefix = ["data", ...scope]
		return {
			compare: this.cache.compare,
			set: (key: Tuple, value: JSONValue) => {
				writes.set?.push({ key: [...fullPrefix, ...key], value })
			},
			delete: (key: Tuple) => {
				writes.delete?.push([...fullPrefix, ...key])
			},
			write: (args) => {
				args.set?.forEach(({ key, value }) => writes.set?.push({ key: [...fullPrefix, ...key], value }))
				args.delete?.forEach((key) => writes.delete?.push([...fullPrefix, ...key]))
			},
			get: (key) => {
				// Optimistic get from cache? 
				const fullKey = [...fullPrefix, ...key]
				// We need to read from the session cache
				const res = this.cache.listRaw({ gte: fullKey, lte: fullKey })
				return res[0]?.value
			},
			list: () => [], // Not supported in reducer usually
			subspace: (p) => this.createProxyTx(writes, [...scope, ...p]),
			// Other methods...
			has: (key) => {
				const fullKey = [...fullPrefix, ...key]
				return this.cache.listRaw({ gte: fullKey, lte: fullKey }).length > 0
			},
			commit: () => {},
			committed: false
		} as unknown as TupleTx
	}

	// ==========================================================================
	// Sync Logic
	// ==========================================================================

	isSyncing = false
	async sync() {
		if (this.isSyncing) return
		this.isSyncing = true

		try {
			while (true) {
				const commitsToSend = this.pendingCommits.map(p => p.commit)
				
				const res = await this.syncCache.api.sync(
					this.prefix,
					commitsToSend as unknown as Commit[], 
					this.syncedClock
				)

				this.handleSyncResponse(res.clock, res.updates)

				const confirmedIds = new Set(res.updates.map(u => u.id).filter(Boolean))
				
				const remaining = this.pendingCommits.filter(p => !confirmedIds.has(p.commit.id))
				
				this.pendingCommits = []
				for (const p of remaining) {
					this.reapplyPending(p)
				}

				if (remaining.length === commitsToSend.length && commitsToSend.length > 0) {
					break
				}
				if (commitsToSend.length === 0 && res.updates.length === 0) {
					break
				}
				if (this.pendingCommits.length === 0 && res.updates.length === 0) {
					break
				}
			}

		} catch (e) {
			console.error("Sync failed", e)
		} finally {
			this.isSyncing = false
		}
	}

	private handleSyncResponse(serverClock: number, updates: Commit[]) {
		// 1. Cleanup ALL pending commits (optimistic)
		for (const p of this.pendingCommits) {
			p.cleanup()
		}

		this.syncedClock = serverClock
		// Update clock in cache
		this.cache.apply({ set: [{ key: ["clock"], value: this.syncedClock }] })

		// 2. Apply Server Updates
		for (const commit of updates) {
			this.applyServerUpdate(commit)
		}
	}

	private applyServerUpdate(commit: Commit) {
		const writes: WriteArgs<Tuple, JSONValue> = { set: [], delete: [] }
		const proxyTx = this.createProxyTx(writes)

		for (const op of commit.ops) {
			const reducer = this.reducers[op.fn] || (defaultReducers as any)[op.fn]
			if (reducer) {
				reducer(proxyTx, ...op.args)
			}
		}

		// Also record history
		writes.set!.push({ key: ["history", commit.clock], value: commit })

		this.cache.apply(writes)
	}

	private reapplyPending(p: PendingCommit<R>) {
		// Re-run reducer
		const writes: WriteArgs<Tuple, JSONValue> = { set: [], delete: [] }
		const proxyTx = this.createProxyTx(writes)
		
		for (const op of p.commit.ops) {
			const reducer = this.reducers[op.fn] || (defaultReducers as any)[op.fn]
			if (reducer) {
				reducer(proxyTx, ...op.args)
			}
		}

		const cleanup = this.cache.write(writes)
		this.pendingCommits.push({
			commit: p.commit,
			cleanup,
			changes: writes
		})
	}
}
