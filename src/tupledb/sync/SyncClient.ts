import { Cache } from "../Cache"
import { tupleTx } from "../TupleDb"
import { TupleDb, TupleTx, WriteArgs } from "../types"
import { SyncHistoryEntry, Operation, ReducerMap, syncDb, defaultReducers } from "../SyncDb"
import { SyncPushRequest, SyncPushResponse } from "./types"

export type SyncTransport = (prefix: any[], req: SyncPushRequest) => Promise<SyncPushResponse>

export type SyncManagerConfig = {
	db: TupleDb
	reducers: ReducerMap
	transport: SyncTransport
}

export class SyncManager {
	db: TupleDb
	reducers: ReducerMap
	transport: SyncTransport
	cache: Cache<any, any>
	sessions = new Map<string, SyncSession>()

	constructor(config: SyncManagerConfig) {
		this.db = config.db
		this.reducers = { ...defaultReducers, ...config.reducers }
		this.transport = config.transport
		this.cache = new Cache(config.db.compare)
	}

	session(prefix: any[]) {
		const key = JSON.stringify(prefix)
		if (!this.sessions.has(key)) {
			this.sessions.set(key, new SyncSession(this, prefix))
		}
		return this.sessions.get(key)!
	}
}

export class SyncSession {
	// We track pending operations as the full Entry (op + metadata) and the cleanup/changes for rollback
	pendingOps: { 
		entry: SyncHistoryEntry; 
		cleanup: () => void; 
		changes: WriteArgs<any, any> 
	}[] = []
	syncedClock: number = 0

	constructor(
		public manager: SyncManager,
		public prefix: any[]
	) {
		this.syncedClock = (this.manager.db.get([...this.prefix, "clock"]) as number) ?? 0
	}

	dispatch(fn: string, ...args: any[]) {
		const op: Operation = { fn, args }
		const metadata = { 
			txId: Math.random().toString(36).slice(2), 
			timestamp: Date.now() 
		}

		// 1. Run Optimistic Reducer
		const reducer = this.manager.reducers[fn]
		if (!reducer) throw new Error(`Unknown reducer: ${fn}`)

		// Capture writes
		const writes: WriteArgs<any, any> = { set: [], delete: [] }
		const proxyTx = this.createProxyTx(writes)

		// Execute reducer on proxy (which mimics the data subspace)
		reducer(proxyTx, ...args)

		// 2. Apply to Cache (Optimistic)
		const scopedWrites = this.filterWrites(writes)
		const cleanup = this.manager.cache.write(scopedWrites)

		// Queue
		this.pendingOps.push({ 
			entry: { op, metadata }, 
			cleanup, 
			changes: scopedWrites 
		})

		// Trigger sync
		this.sync()
	}

	filterWrites(writes: WriteArgs<any, any>): WriteArgs<any, any> {
		const isMatch = (key: any[]) => {
			if (key.length < this.prefix.length) return false
			for (let i = 0; i < this.prefix.length; i++) {
				if (this.manager.db.compare(key[i], this.prefix[i]) !== 0) return false
			}
			return true
		}

		return {
			set: writes.set?.filter(({ key }) => isMatch(key)) || [],
			delete: writes.delete?.filter((key) => isMatch(key)) || [],
		}
	}

	createProxyTx(writes: WriteArgs<any, any>, scope: any[] = []): TupleTx {
		// This proxy mimics `dataSpace`. 
		// Since we are in `SyncSession` which manages `prefix`, the optimistic reducer 
		// is likely running on `prefix`.
		// However, the `SyncDb` wrapper on server passes `dataSpace` (subspace of `prefix`).
		// So `proxyTx` should behave like `dataSpace`.
		// BUT `SyncSession` writes go to `writes` buffer.
		// We need to ensure keys are prefixed correctly for the `writes` buffer so `filterWrites` works?
		// `filterWrites` expects Fully Qualified (FQ) keys (root).
		
		// If reducer writes to `["inbox"]`, and we are in `["user", 1]`, we want FQ key `["user", 1, "data", "inbox"]`.
		// The `SyncDb` uses `data` subspace.
		
		const dataPrefix = [...this.prefix, "data", ...scope]

		return {
			compare: this.manager.db.compare,
			set: (key: any, value: any) => {
				writes.set?.push({ key: [...dataPrefix, ...key], value })
			},
			delete: (key: any) => {
				writes.delete?.push([...dataPrefix, ...key])
			},
			write: (args: WriteArgs<any, any>) => {
				args.set?.forEach(({ key, value }) => writes.set?.push({ key: [...dataPrefix, ...key], value }))
				args.delete?.forEach((key) => writes.delete?.push([...dataPrefix, ...key]))
			},
			get: (key: any) => {
				const fullKey = [...dataPrefix, ...key]
				const res = this.manager.cache.list({ gte: fullKey, lte: fullKey })
				return res.hit?.[0]?.value
			},
			list: () => [], // TODO: Cache list read
			commit: () => {},
			committed: false,
			has: (key: any) => {
				const fullKey = [...dataPrefix, ...key]
				return !!this.manager.cache.list({ gte: fullKey, lte: fullKey }).hit?.length
			},
			subspace: (p: any) => {
				return this.createProxyTx(writes, [...scope, ...p])
			},
		} as unknown as TupleTx
	}

	isSyncing = false
	async sync() {
		if (this.isSyncing) return
		this.isSyncing = true

		try {
			while (true) {
				const entriesToSend = this.pendingOps.map((p) => p.entry)
				if (entriesToSend.length === 0) break

				const res = await this.manager.transport(this.prefix, {
					ops: entriesToSend,
					syncedClock: this.syncedClock,
				})

				// 1. Revert ALL pending ops
				for (const p of this.pendingOps) {
					p.cleanup()
				}

				// 2. Apply Updates from Server
				this.syncedClock = res.serverClock
				this.manager.db.set([...this.prefix, "clock"], this.syncedClock)

				for (const entry of res.updates) {
					this.applyServerUpdate(entry)
				}

				// 3. Determine remaining pending ops
				const confirmedTxIds = new Set(res.updates.map((u) => u.metadata.txId).filter(Boolean))
				
				const remainingOps = this.pendingOps.filter(p => !confirmedTxIds.has(p.entry.metadata.txId))
				this.pendingOps = []

				// 4. Re-apply remaining pending ops
				for (const p of remainingOps) {
					const reducer = this.manager.reducers[p.entry.op.fn]
					if (!reducer) continue

					const writes: WriteArgs<any, any> = { set: [], delete: [] }
					const proxyTx = this.createProxyTx(writes)

					// Re-run reducer
					reducer(proxyTx, ...p.entry.op.args)

					const scopedWrites = this.filterWrites(writes)
					const cleanup = this.manager.cache.write(scopedWrites)
					
					this.pendingOps.push({ entry: p.entry, cleanup, changes: scopedWrites })
				}

				if (remainingOps.length === entriesToSend.length) break
				if (this.pendingOps.length === 0) break
			}
		} catch (e) {
			console.error("Sync failed", e)
		} finally {
			this.isSyncing = false
		}
	}

	applyServerUpdate(entry: SyncHistoryEntry) {
		// Run the reducer locally to generate the writes
		// The server sent the Semantic Op
		const reducer = this.manager.reducers[entry.op.fn]
		if (!reducer) {
			console.warn(`Unknown reducer from server: ${entry.op.fn}`)
			return
		}

		// We need to capture writes again
		// This time we write them to the persistent DB AND Cache
		// But wait, if we write to DB, we don't need to write to Cache if Cache is just a view over DB?
		// No, Cache is separate (InMemory) in this architecture or an overlay?
		// Usually Cache is an overlay on top of DB. 
		// If we write to DB, the Cache should invalidate or update.
		// Here `manager.cache` seems to be an InMemoryOkv used for UI subscriptions.
		
		const writes: WriteArgs<any, any> = { set: [], delete: [] }
		const proxyTx = this.createProxyTx(writes) // Encodes to FQ keys

		reducer(proxyTx, ...entry.op.args)

		const scopedWrites = this.filterWrites(writes)
		
		// Write to Local DB (Persistent)
		this.manager.db.write(scopedWrites)
		
		// Write to Cache (View)
		this.manager.cache.write(scopedWrites)
	}
}
