import { Cache } from "../Cache"
import { TupleSubspaceEncoder } from "../Encoder"
import { tupleTx } from "../TupleDb"
import { TupleDb, TupleTx, WriteArgs } from "../types"
import { SyncHistoryEntry, syncDb } from "../SyncDb"
import { Operation, ReducerMap, SyncPushRequest, SyncPushResponse } from "./types"

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
		this.reducers = config.reducers
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
	pendingOps: { op: Operation; cleanup: () => void; changes: WriteArgs<any, any> }[] = []
	syncedClock: number = 0

	constructor(
		public manager: SyncManager,
		public prefix: any[]
	) {
		// Hydrate state
		// Use prefix+["clock"]
		this.syncedClock = (this.manager.db.get([...this.prefix, "clock"]) as number) ?? 0
	}

	dispatch(fn: string, ...args: any[]) {
		const op: Operation = {
			id: Math.random().toString(36).slice(2),
			fn,
			args,
			timestamp: Date.now(),
		}

		// 1. Run Optimistic Reducer
		const reducer = this.manager.reducers[fn]
		if (!reducer) throw new Error("Unknown reducer")

		// Capture writes
		const writes: WriteArgs<any, any> = { set: [], delete: [] }
		const proxyTx = this.createProxyTx(writes)

		// Context-aware execution
		const contextTx = Object.create(proxyTx)
		contextTx.syncMetadata = { txId: op.id, timestamp: op.timestamp }

		reducer(contextTx, ...args)

		// 2. Apply to Cache (Optimistic)
		// Writes are already Fully Qualified (FQ) from Root because createProxyTx handles subspace.
		// We filter to ensure we only apply writes relevant to this session
		const scopedWrites = this.filterWrites(writes)
		
		const cleanup = this.manager.cache.write(scopedWrites)

		// Queue
		this.pendingOps.push({ op, cleanup, changes: scopedWrites })

		// Trigger sync
		this.sync()
	}

	filterWrites(writes: WriteArgs<any, any>): WriteArgs<any, any> {
		// We only allow writes that start with `this.prefix`
		// This is a basic form of client-side sharding/security.
		// The generic reducer might try to write elsewhere, but this session can't track it.
		
		// Helper to check prefix
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
		return {
			compare: this.manager.db.compare,
			set: (key: any, value: any) => {
				writes.set?.push({ key: [...scope, ...key], value })
			},
			delete: (key: any) => {
				writes.delete?.push([...scope, ...key])
			},
			get: (key: any) => {
				// Read from GLOBAL cache using FQ key
				const fullKey = [...scope, ...key]
				const res = this.manager.cache.list({ gte: fullKey, lte: fullKey })
				return res.hit?.[0]?.value
			},
			list: (args: any) => {
				// We don't support complex range reads in optimistic reducer yet
				return []
			},
			write: (args: WriteArgs<any, any>) => {
				args.set?.forEach(({ key, value }) => writes.set?.push({ key: [...scope, ...key], value }))
				args.delete?.forEach((key) => writes.delete?.push([...scope, ...key]))
			},
			commit: () => {},
			committed: false,
			has: (key: any) => {
				const fullKey = [...scope, ...key]
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
				const opsToSend = this.pendingOps.map((p) => p.op)
				if (opsToSend.length === 0) {
					// Check if we need to pull?
					// For now we just return.
					// A real implementation would track "lastPull" and pull if stale.
					break
				}

				const res = await this.manager.transport(this.prefix, {
					ops: opsToSend,
					syncedClock: this.syncedClock,
				})

				// 1. Revert ALL pending ops
				for (const p of this.pendingOps) {
					p.cleanup()
				}

				// 2. Apply Updates from Server
				// Update clock
				this.syncedClock = res.serverClock
				this.manager.db.set([...this.prefix, "clock"], this.syncedClock)

				// Apply changes to local DB and Cache
				for (const entry of res.updates) {
					this.applyServerUpdate(entry)
				}

				// 3. Determine remaining pending ops
				const confirmedTxIds = new Set(res.updates.map((u) => u.metadata.txId).filter(Boolean))
				
				const remainingOps = this.pendingOps.filter(p => !confirmedTxIds.has(p.op.id))
				this.pendingOps = []

				// 4. Re-apply remaining pending ops
				for (const p of remainingOps) {
					// Re-run reducer to handle state dependency changes
					const reducer = this.manager.reducers[p.op.fn]
					if (!reducer) continue

					const writes: WriteArgs<any, any> = { set: [], delete: [] }
					const proxyTx = this.createProxyTx(writes)
					const contextTx = Object.create(proxyTx)
					contextTx.syncMetadata = { txId: p.op.id, timestamp: p.op.timestamp }

					reducer(contextTx, ...p.op.args)

					const scopedWrites = this.filterWrites(writes)
					const cleanup = this.manager.cache.write(scopedWrites)
					
					this.pendingOps.push({ op: p.op, cleanup, changes: scopedWrites })
				}

				if (remainingOps.length === opsToSend.length) {
					// No progress made (no updates confirmed), stop loop to avoid infinite spin
					// This happens if server processed but didn't return updates (maybe empty history?)
					// Or if server is behind?
					// In a real system, we might backoff.
					break
				}
				if (this.pendingOps.length === 0) break
			}
		} catch (e) {
			console.error("Sync failed", e)
		} finally {
			this.isSyncing = false
		}
	}

	applyServerUpdate(entry: SyncHistoryEntry) {
		const { changes } = entry
		
		// Changes in HistoryEntry are logical (relative to data root)
		// We must map them to FQ keys: [...prefix, "data", ...key]
		const dataPrefix = [...this.prefix, "data"]

		const prefixedSets = changes.set?.map(({ key, value }) => ({
			key: [...dataPrefix, ...key],
			value,
		}))
		const prefixedDeletes = changes.delete?.map((key) => [...dataPrefix, ...key])

		const writes = { set: prefixedSets, delete: prefixedDeletes }
		this.manager.db.write(writes)
		this.manager.cache.write(writes)
	}
}