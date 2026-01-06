import { randomId } from "../shared/randomId"
import { codec } from "../tupleDb/Codec"
import { OkvCache, cachedRange } from "../tupleDb/OkvCache"
import { TupleCache } from "../tupleDb/TupleCache"
import { readOnlyTupleDb } from "../tupleDb/TupleDb"
import { ListArgs, Tuple, TupleTx, WriteArgs } from "../tupleDb/types"
import { defaultReducers } from "./SyncDb"
import {
	Commit,
	CommitMeta,
	IClientSyncDb,
	ISyncClient,
	JSONValue,
	OpsBuilder,
	Pubsub,
	ReducerMap,
	SubscribeResult,
	SyncApi,
} from "./types"

export class SyncClient<GlobalReducers extends ReducerMap> implements ISyncClient<GlobalReducers> {
	cache: TupleCache
	api: SyncApi
	pubsub: Pubsub
	reducers: GlobalReducers

	// Pending global commits to be sent to the server
	pendingCommits: Commit[] = []

	// Map of prefix (JSON) -> Session State
	sessions = new Map<string, SessionState>()

	constructor(args: { api: SyncApi; pubsub: Pubsub; reducers: GlobalReducers }) {
		this.api = args.api
		this.pubsub = args.pubsub
		this.reducers = args.reducers
		this.cache = new TupleCache(new OkvCache(codec.compare))
	}

	// ==========================================================================
	// Global Write
	// ==========================================================================

	write(meta: CommitMeta, build: (ops: OpsBuilder<GlobalReducers>) => void) {
		const ops: any[] = []
		const proxy = new Proxy(
			{},
			{
				get:
					(_, fn) =>
					(...args: any[]) =>
						ops.push({ fn: fn as string, args }),
			}
		)
		build(proxy)

		const now = new Date().toISOString()
		const commit: Commit = {
			id: randomId(),
			clock: 0, // Global path is "shallow", doesn't need strict ordering/clocking on client
			commitedAt: now,
			createdAt: now,
			ops,
			...meta,
		}

		// Optimistic Apply
		// We need to capture all writes to subspaces
		const changes: WriteArgs<Tuple, JSONValue> = { set: [], delete: [] }
		const tx = this.createCaptureTx(changes)

		// Run reducers
		for (const op of ops) {
			const reducer = this.reducers[op.fn]
			if (!reducer) throw new Error(`Unknown reducer: ${op.fn}`)
			// We pass the tx. The reducer can call tx.subspace(...).
			// Then it might use syncDb(subspace).write(...)
			reducer(tx, ...op.args)
		}

		// Apply changes to cache
		const cleanup = this.cache.write(changes)

		// Queue commit
		this.pendingCommits.push(commit)

		// Trigger sync (fire and forget)
		this.sync()
	}

	private createCaptureTx(writes: WriteArgs<Tuple, JSONValue>, prefix: Tuple = []): any {
		// We mimic a TupleTx but we intercept writes.
		// We also need to allow reading from the cache + current writes (ideally).
		// For now, reading from cache is enough for most optimistic cases.
		const self = this
		const tx: Partial<TupleTx> = {
			compare: self.cache.compare,
			subspace: (p: Tuple) => self.createCaptureTx(writes, [...prefix, ...p]),
			set: (key: Tuple, value: JSONValue) => {
				writes.set?.push({ key: [...prefix, ...key], value })
			},
			delete: (key: Tuple) => {
				writes.delete?.push([...prefix, ...key])
			},
			get: (key: Tuple) => {
				const fullKey = [...prefix, ...key]
				// TODO: check 'writes' for dirty read?
				const res = self.cache.list({ gte: fullKey, lte: fullKey })
				return res.hit?.[0]?.value
			},
			list: (args: ListArgs<Tuple> = {}) => {
				const fullArgs = { ...args }
				if (fullArgs.gte) fullArgs.gte = [...prefix, ...fullArgs.gte]
				if (fullArgs.lte) fullArgs.lte = [...prefix, ...fullArgs.lte]
				if (fullArgs.gt) fullArgs.gt = [...prefix, ...fullArgs.gt]
				if (fullArgs.lt) fullArgs.lt = [...prefix, ...fullArgs.lt]

				// We don't handle reverse/limit perfectly here relative to prefix if it spans,
				// but for single subspace operations it should be fine.
				const res = self.cache.list(fullArgs)
				return (res.hit || []).map((item) => ({
					key: item.key.slice(prefix.length),
					value: item.value,
				}))
			},
			write: (args: WriteArgs<Tuple, JSONValue>) => {
				args.set?.forEach(({ key, value }) => {
					writes.set?.push({ key: [...prefix, ...key], value })
				})
				args.delete?.forEach((key) => {
					writes.delete?.push([...prefix, ...key])
				})
			},
			// Helper for SyncDb factory usage
			commit: () => {}, // No-op, we capture writes
		}

		// We need to match TupleTx shape enough for syncDb/reducers
		return tx as TupleTx
	}

	// ==========================================================================
	// Sync Logic
	// ==========================================================================

	isSyncing = false
	async sync() {
		if (this.isSyncing) return
		this.isSyncing = true

		try {
			// Flush pending global commits
			// We assume the server endpoint for global writes is root []
			// or a specific global endpoint.
			// The current SyncApi.sync takes a scope.
			// We'll use [] as global scope.

			while (this.pendingCommits.length > 0) {
				const batch = [...this.pendingCommits]
				// Send to server
				// Note: existing sync() api returns updates.
				// For global write, we might get updates for ANY subspace.
				// But SyncApi.sync implies scoping.
				// We might need a generic "push" api.
				// For now, let's assume sync([]) handles global.

				const res = await this.api.sync([], batch, 0)

				// Success (assumed). Remove from pending.
				// Note: if server fails, we retry.
				this.pendingCommits = this.pendingCommits.filter((c) => !batch.includes(c))

				// We might get updates back. If so, handle them.
				// Global sync response might contain updates for subspaces?
				// If the server fans out, it might just return "OK".
				// The updates will come via pubsub/subscription to specific DBs.
			}
		} catch (e) {
			console.error("Global Sync failed", e)
		} finally {
			this.isSyncing = false
		}
	}

	// ==========================================================================
	// Subspace / Session
	// ==========================================================================

	syncDb<R extends ReducerMap>(prefix: Tuple, reducers: R): IClientSyncDb<R> {
		const key = JSON.stringify(prefix)
		if (!this.sessions.has(key)) {
			this.sessions.set(key, new SessionState(this, prefix, reducers))
		}
		return this.sessions.get(key)! as unknown as IClientSyncDb<R>
	}
}

class SessionState<R extends ReducerMap> implements IClientSyncDb<R> {
	cache: TupleCache
	dataCache: TupleCache
	syncedClock = 0

	constructor(
		public client: SyncClient<any>,
		public prefix: Tuple,
		public reducers: R
	) {
		this.cache = client.cache.subspace(prefix)
		this.dataCache = this.cache.subspace(["data"])

		// Initialize clock from cache
		const clockRes = this.cache.list({ gte: ["clock"], lte: ["clock"] })
		this.syncedClock = (clockRes.hit?.[0]?.value as number) || 0
	}

	clock = () => this.syncedClock

	get data() {
		const self = this
		const db = readOnlyTupleDb({
			compare: this.dataCache.compare,
			list: (args) => this.dataCache.list(args).hit || [],
			get: (key) => this.dataCache.list({ gte: key, lte: key }).hit?.[0]?.value,
			has: (key) => (this.dataCache.list({ gte: key, lte: key }).hit?.length || 0) > 0,
			subspace: (p) => {
				throw new Error("Subspace not fully implemented on ClientSyncDb data")
			},
		} as any)

		return {
			...db,
			subscribe: (
				args: ListArgs<Tuple>,
				listener: (result: { hit?: any[]; miss?: boolean; prefix?: any[] }) => void
			): SubscribeResult => {
				return self.subscribeData(args, listener)
			},
		}
	}

	get history() {
		const historyCache = this.cache.subspace(["history"])
		return {
			list: (args: ListArgs<Tuple> = {}) => {
				return historyCache.list(args).hit || []
			},
		}
	}

	sync = async () => {
		// Fetch updates for this subspace
		try {
			const res = await this.client.api.fetch(this.prefix, this.syncedClock)
			this.handleUpdates(res.clock, res.updates)
		} catch (e) {
			console.error("Fetch failed", e)
		}
	}

	private async fetchAndApply(args: ListArgs<Tuple>) {
		try {
			const res = await this.client.api.read(this.prefix, args, this.syncedClock)
			this.handleUpdates(res.clock, res.updates)
			this.dataCache.insert([{ args, result: res.data }])
			return res.data
		} catch (e) {
			console.error("Fetch failed", e)
			throw e
		}
	}

	private subscribeData(
		args: ListArgs<Tuple>,
		listener: (result: { hit?: any[]; miss?: boolean; prefix?: any[] }) => void
	): SubscribeResult {
		const cacheUnsub = this.dataCache.subscribe(cachedRange(args, []), () => {
			const res = this.dataCache.list(args)
			listener(res)
		})

		const clockTuple = [...this.prefix, "clock"]
		const pubsubUnsub = this.client.pubsub.onMessage((tuple, value) => {
			if (codec.compare(tuple, clockTuple) === 0) {
				this.sync()
			}
		})
		this.client.pubsub.subscribe(clockTuple)

		const remote = this.fetchAndApply(args)

		const initialRes = this.dataCache.list(args)

		return {
			local: initialRes,
			remote,
			unsubscribe: () => {
				cacheUnsub()
				pubsubUnsub()
			},
		}
	}

	private handleUpdates(serverClock: number, updates: Commit[]) {
		this.syncedClock = serverClock
		// We insert the new clock and the history/data
		// Note: The server sends 'updates' which are Commits.
		// We need to apply them to the cache.
		// BUT we might have already applied them optimistically via Global Write!
		// If so, we are just "confirming" them.
		// However, the Commit ID might be different if the server regenerated it?
		// Or if the server generated the Local Commit from the Global Commit.
		// Ideally, we just re-apply. Idempotency is key.

		const writes: WriteArgs<Tuple, JSONValue> = { set: [], delete: [] }
		writes.set!.push({ key: ["clock"], value: this.syncedClock })

		for (const commit of updates) {
			writes.set!.push({ key: ["history", commit.clock], value: commit })

			const proxyTx = this.createProxyTx(writes)
			for (const op of commit.ops) {
				const reducer = this.reducers[op.fn] || (defaultReducers as any)[op.fn]
				if (reducer) {
					reducer(proxyTx, ...op.args)
				}
			}
		}

		this.cache.write(writes)
	}

	private createProxyTx(writes: WriteArgs<Tuple, JSONValue>, scope: Tuple = []): TupleTx {
		// Similar to existing logic, applies to "data" subspace
		const fullPrefix = ["data", ...scope]
		return {
			compare: this.cache.compare,
			set: (key: Tuple, value: JSONValue) => {
				writes.set?.push({ key: [...fullPrefix, ...key], value })
			},
			delete: (key: Tuple) => {
				writes.delete?.push([...fullPrefix, ...key])
			},
			get: (key) => {
				// Optimistic get from cache
				const fullKey = [...fullPrefix, ...key]
				return this.cache.list({ gte: fullKey, lte: fullKey }).hit?.[0]?.value
			},
			subspace: (p) => this.createProxyTx(writes, [...scope, ...p]),
			// ... other methods stubbed
			has: (key) => {
				const fullKey = [...fullPrefix, ...key]
				return (this.cache.list({ gte: fullKey, lte: fullKey }).hit?.length || 0) > 0
			},
			commit: () => {},
			write: () => {},
			list: () => [],
			committed: false,
		} as unknown as TupleTx
	}
}
