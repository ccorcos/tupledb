import { Cache, cachedRange } from "../tupleDb/Cache"
import { codec } from "../tupleDb/Codec"
import { readOnlyTupleDb, tupleTx } from "../tupleDb/TupleDb"
import { ListArgs, ReadOnlyTupleDb, Tuple, TupleTx, WriteArgs } from "../tupleDb/types"
import { defaultReducers } from "./SyncDb"
import { Commit, JSONValue, Op, PendingCommit, Pubsub, ReducerMap, SubscribeResult, SyncApi } from "./types"
import { randomId } from "../shared/randomId"

export class SyncCache {
	cache: Cache<Tuple, JSONValue>
	api: SyncApi
	pubsub: Pubsub
	// We cache ClientSyncDb instances to share state (like pending commits/clock) for the same prefix.
	sessions = new Map<string, ClientSyncDb<any>>()

	constructor(args: { api: SyncApi; pubsub: Pubsub }) {
		this.api = args.api
		this.pubsub = args.pubsub
		this.cache = new Cache(codec.compare)
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

export class ClientSyncDb<R extends ReducerMap> {
	pendingCommits: PendingCommit<R>[] = []
	syncedClock: number = 0
	
	// Helper to access the global cache with prefix
	dataPrefix: Tuple

	constructor(
		public syncCache: SyncCache,
		public prefix: Tuple,
		public reducers: R
	) {
		this.dataPrefix = [...prefix, "data"]
		// Initialize clock from cache if available? 
		// Actually clock is stored at [...prefix, "clock"]
		const clock = this.syncCache.cache.listRaw({ gte: [...prefix, "clock"], lte: [...prefix, "clock"] })[0]?.value
		this.syncedClock = (clock as number) || 0
	}

	// ==========================================================================
	// Data API
	// ==========================================================================

	get data() {
		const self = this
		const db = readOnlyTupleDb({
			compare: this.syncCache.cache.compare,
			list: (args) => this.listData(args),
			get: (key) => this.listData({ gte: key, lte: key })[0]?.value,
			has: (key) => this.listData({ gte: key, lte: key }).length > 0,
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

	private listData(args: ListArgs<Tuple>) {
		const fullArgs = this.prefixArgs(args, this.dataPrefix)
		const result = this.syncCache.cache.list(fullArgs)
		if (result.hit) {
			return result.hit.map(kv => ({ key: kv.key.slice(this.dataPrefix.length), value: kv.value }))
		}
		return [] // Fallback if miss
	}

	private subscribeData(args: ListArgs<Tuple>, listener: (result: { hit?: any[]; miss?: boolean; prefix?: any[] }) => void): SubscribeResult {
		const fullArgs = this.prefixArgs(args, this.dataPrefix)
		
		// 1. Local Cache Subscription
		const cacheUnsub = this.syncCache.cache.subscribe(cachedRange(fullArgs, []), () => {
			const res = this.syncCache.cache.list(fullArgs)
			listener(this.formatCacheResult(res))
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
		const initialRes = this.syncCache.cache.list(fullArgs)
		
		return {
			local: this.formatCacheResult(initialRes),
			remote,
			unsubscribe: () => {
				cacheUnsub()
				pubsubUnsub()
				// Maybe unsubscribe from pubsub topic if no more listeners?
			}
		}
	}

	private formatCacheResult(res: { hit?: any[]; miss?: boolean; prefix?: any[] }) {
		if (res.hit) return { hit: res.hit.map(kv => ({ key: kv.key.slice(this.dataPrefix.length), value: kv.value })) }
		if (res.prefix) return { prefix: res.prefix.map(kv => ({ key: kv.key.slice(this.dataPrefix.length), value: kv.value })) }
		return { miss: true }
	}

	private async fetchAndApply(args: ListArgs<Tuple>) {
		try {
			// Determine range relative to dataPrefix
			// The API read expects "scope" (prefix) and "range" (relative args)
			const res = await this.syncCache.api.read(this.prefix, args, this.syncedClock)
			
			this.handleSyncResponse(res.clock, res.updates)
			
			// Insert the data snapshot into cache
			// The data returned by read() is absolute keys or relative? 
			// SyncServer.read returns `data` from `scopeDb.data.list(range)`.
			// `scopeDb` is `syncDb(db.subspace(scope))`.
			// `scopeDb.data` is `readOnlyTupleDb(db.subspace(scope).subspace(["data"]))`.
			// So the keys returned by `read()` are relative to `[...scope, "data"]`.
			// Wait, `readOnlyTupleDb` `list` returns keys relative to its root?
			// No, `TupleDb` usually returns keys as stored in the underlying OKV unless specific wrappers strip them.
			// `readOnlyTupleDb` uses `db.list`.
			// `db.subspace` wraps `db` with `subspace`. 
			// `subspace` in `TupleDb.ts` uses `KeyDecodeList` which strips the prefix.
			// So yes, the keys returned by `server.read` are relative to `[...prefix, "data"]`.

			// We need to re-prefix them to store in the global cache.
			const prefixedData = res.data.map(({ key, value }) => ({
				key: [...this.dataPrefix, ...key],
				value
			}))

			// Insert into cache
			const fullArgs = this.prefixArgs(args, this.dataPrefix)
			this.syncCache.cache.insert(fullArgs, prefixedData)
			
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
		const historyPrefix = [...this.prefix, "history"]
		const self = this
		
		// TODO: Implement read-only DB wrapper for history
		// For now just enough for tests/usage
		return {
			list: (args: ListArgs<Tuple> = {}) => {
				const fullArgs = self.prefixArgs(args, historyPrefix)
				const result = self.syncCache.cache.listRaw(fullArgs)
				return result.map(kv => ({ key: kv.key.slice(historyPrefix.length), value: kv.value }))
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

	write(meta: any, build: (ops: any) => void) {
		const ops: Op<R>[] = []
		const proxy = new Proxy({}, {
			get: (_, fn) => (...args: any[]) => ops.push({ fn: fn as string as keyof R & string, args: args as any })
		})
		build(proxy)

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
		const writes: WriteArgs<Tuple, JSONValue> = { set: [], delete: [] }
		
		// Create a proxy tx that writes to `writes` array
		// It acts on `[...prefix, "data"]`
		const proxyTx = this.createProxyTx(writes)

		for (const op of ops) {
			const reducer = this.reducers[op.fn as string] || (defaultReducers as any)[op.fn as string]
			if (!reducer) throw new Error(`Unknown reducer: ${op.fn as string}`)
			
			const context = Object.create(proxyTx)
			context.syncMetadata = commit
			reducer(context, ...op.args)
		}

		const cleanup = this.syncCache.cache.write(writes)

		this.pendingCommits.push({
			commit,
			cleanup,
			changes: writes
		})

		this.sync()
	}

	private createProxyTx(writes: WriteArgs<Tuple, JSONValue>, scope: Tuple = []): TupleTx {
		const fullPrefix = [...this.dataPrefix, ...scope]
		return {
			compare: this.syncCache.cache.compare,
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
				// We should read from cache INCLUDING pending writes that are already in cache.
				// SyncCache.cache.list handles pending writes of the cache itself.
				const fullKey = [...fullPrefix, ...key]
				const res = this.syncCache.cache.list({ gte: fullKey, lte: fullKey })
				return res.hit?.[0]?.value
			},
			list: () => [], // Not supported in reducer usually
			subspace: (p) => this.createProxyTx(writes, [...scope, ...p]),
			// Other methods...
			has: (key) => {
				const fullKey = [...fullPrefix, ...key]
				return !!this.syncCache.cache.list({ gte: fullKey, lte: fullKey }).hit?.length
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
			// 1. Fetch any new updates from server (if we are just syncing)
			// OR send pending commits.
			
			// If we have pending commits, we send them.
			// If not, we just fetch? 
			// `api.sync` does both: writes and returns updates.
			// If no commits to send, we can call `api.fetch`.
			
			// But `sync` method on server does `write` then `fetch`.
			// If commits list is empty, `write` does nothing.
			// So we can always use `api.sync`.

			while (true) {
				const commitsToSend = this.pendingCommits.map(p => p.commit)
				
				// Optimistically, we don't clear pending commits until confirmed.
				// But we also don't want to re-send commits that are already sent but not acked?
				// For simplicity, we send all pending. The server handles idempotency.
				
				// But wait, if we are just fetching (because of pubsub clock update), commitsToSend might be empty.
				// That's fine.

				// CAST: Ensure generic compatibility
				const res = await this.syncCache.api.sync(
					this.prefix,
					commitsToSend as unknown as Commit[], 
					this.syncedClock
				)

				this.handleSyncResponse(res.clock, res.updates)

				// Identify which pending commits are confirmed/acked
				const confirmedIds = new Set(res.updates.map(u => u.id).filter(Boolean))
				
				// Also, if we sent commits, they might be acknowledged implicitly?
				// `SyncServer.write` applies commits and returns new clock.
				// The returned `updates` from `SyncServer.sync` -> `fetch` contains all history > syncedClock.
				// So if our writes were applied, they should appear in `updates`.

				// Filter out confirmed commits from pending
				const remaining = this.pendingCommits.filter(p => !confirmedIds.has(p.commit.id))
				
				// Cleanup confirmed commits (remove their optimistic effect, because server effect is applied)
				// Wait, `handleSyncResponse` applies server updates.
				// We need to remove optimistic effect of ALL pending commits temporarily, apply server updates, then re-apply remaining pending commits.
				// But `SyncCache` implementation of `handleSyncResponse` in `SyncClient` (previous) did:
				// 1. Cleanup ALL pending.
				// 2. Update clock.
				// 3. Apply server updates.
				// 4. Re-apply remaining pending.

				// Let's do that.
				
				// Actually `handleSyncResponse` below does the apply server updates.
				// But we need to manage pending list here.
				
				// Re-apply remaining
				this.pendingCommits = []
				for (const p of remaining) {
					// We need to re-run the reducer because the base state might have changed!
					this.reapplyPending(p)
				}

				if (remaining.length === commitsToSend.length && commitsToSend.length > 0) {
					// No progress made on sending commits?
					// Maybe server rejected them or they are not yet in history?
					// Break to avoid infinite loop.
					break
				}
				if (commitsToSend.length === 0 && res.updates.length === 0) {
					// Nothing sent, nothing received.
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
		this.syncCache.cache.write({ set: [{ key: [...this.prefix, "clock"], value: this.syncedClock }] })

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
				const context = Object.create(proxyTx)
				context.syncMetadata = commit
				reducer(context, ...op.args)
			}
		}

		// Also record history
		writes.set!.push({ key: [...this.prefix, "history", commit.clock], value: commit })

		this.syncCache.cache.apply(writes)
	}

	private reapplyPending(p: PendingCommit<R>) {
		// Re-run reducer
		const writes: WriteArgs<Tuple, JSONValue> = { set: [], delete: [] }
		const proxyTx = this.createProxyTx(writes)
		
		for (const op of p.commit.ops) {
			const reducer = this.reducers[op.fn] || (defaultReducers as any)[op.fn]
			if (reducer) {
				const context = Object.create(proxyTx)
				context.syncMetadata = p.commit
				reducer(context, ...op.args)
			}
		}

		const cleanup = this.syncCache.cache.write(writes)
		this.pendingCommits.push({
			commit: p.commit,
			cleanup,
			changes: writes
		})
	}


	// ==========================================================================
	// Utils
	// ==========================================================================

	private prefixArgs(args: ListArgs<Tuple>, prefix: Tuple): ListArgs<Tuple> {
		const prefixKey = (k: Tuple) => [...prefix, ...k]
		return {
			...args,
			gt: args.gt ? prefixKey(args.gt) : undefined,
			gte: args.gte ? prefixKey(args.gte) : undefined,
			lt: args.lt ? prefixKey(args.lt) : undefined,
			lte: args.lte ? prefixKey(args.lte) : undefined,
		}
	}
}
