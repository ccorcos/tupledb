import { Cache } from "../Cache"
import { TupleDb, TupleTx, WriteArgs, ListArgs, Tuple } from "../types"
import { SyncHistoryEntry, Operation, ReducerMap, syncDb } from "../SyncDb"
import { SyncResult, ReadResult, WriteResult } from "./types"

export type SyncTransport = {
	write: (prefix: any[], ops: SyncHistoryEntry[]) => Promise<WriteResult>
	sync: (prefix: any[], ops: SyncHistoryEntry[], syncedClock: number) => Promise<SyncResult>
	read: (prefix: any[], range: ListArgs<Tuple>, syncedClock: number) => Promise<ReadResult>
}

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

	async list(args: ListArgs<Tuple>): Promise<{ key: Tuple; value: any }[]> {
		const dataPrefix = [...this.prefix, "data"]
		const prefixKey = (k: any[]) => [...dataPrefix, ...k]
		const prefixedArgs: ListArgs<Tuple> = {
			...args,
			gt: args.gt ? prefixKey(args.gt) : undefined,
			gte: args.gte ? prefixKey(args.gte) : undefined,
			lt: args.lt ? prefixKey(args.lt) : undefined,
			lte: args.lte ? prefixKey(args.lte) : undefined,
		}

		// 1. Check Cache
		const cacheResult = this.manager.cache.list(prefixedArgs)
		if (cacheResult.hit) {
			return cacheResult.hit.map(({ key, value }) => ({
				key: key.slice(dataPrefix.length),
				value
			}))
		}

		// 2. Fetch from Server
		try {
			const res = await this.manager.transport.read(this.prefix, args, this.syncedClock)
			
			// 3. Apply Updates
			this.handleSyncResponse(res.clock, res.updates)

			// 4. Insert Data
			const prefixedData = res.data.map(({ key, value }) => ({
				key: prefixKey(key),
				value
			}))
			this.manager.cache.insert(prefixedArgs, prefixedData)

			// 5. Return Merged Result
			const finalResult = this.manager.cache.list(prefixedArgs)
			return (finalResult.hit || prefixedData).map(({ key, value }) => ({
				key: key.slice(dataPrefix.length),
				value
			}))

		} catch (e) {
			console.error("Read failed", e)
			throw e
		}
	}

	dispatch(fn: string, ...args: any[]) {
		const op: Operation = { fn, args }
		const metadata = { 
			txId: Math.random().toString(36).slice(2), 
			timestamp: Date.now() 
		}

		let reducer = this.manager.reducers[fn]
		// Fallback for default reducers
		if (!reducer && (fn === "set" || fn === "delete")) {
			if (fn === "set") reducer = (db: any, k: any, v: any) => db.set(k, v)
			if (fn === "delete") reducer = (db: any, k: any) => db.delete(k)
		}
		if (!reducer) throw new Error(`Unknown reducer: ${fn}`)

		const writes: WriteArgs<any, any> = { set: [], delete: [] }
		const proxyTx = this.createProxyTx(writes)
		const contextTx = Object.create(proxyTx)
		contextTx.syncMetadata = metadata
		reducer(contextTx, ...args)

		const scopedWrites = this.filterWrites(writes)
		const cleanup = this.manager.cache.write(scopedWrites)

		this.pendingOps.push({ 
			entry: { op, metadata }, 
			cleanup, 
			changes: scopedWrites 
		})

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
			list: () => [], 
			commit: () => {},
			committed: false,
			has: (key: any) => {
				const fullKey = [...dataPrefix, ...key]
				return !!this.manager.cache.list({ gte: fullKey, lte: fullKey }).hit?.length
			},
			subspace: (p: any) => this.createProxyTx(writes, [...scope, ...p]),
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

				const res = await this.manager.transport.sync(
					this.prefix, 
					entriesToSend, 
					this.syncedClock
				)

				this.handleSyncResponse(res.clock, res.updates)
				
				const confirmedTxIds = new Set(res.updates.map((u) => u.metadata.txId).filter(Boolean))
				const remainingOps = this.pendingOps.filter(p => !confirmedTxIds.has(p.entry.metadata.txId))
				this.pendingOps = []

				for (const p of remainingOps) {
					// Re-apply optimistic
					let reducer = this.manager.reducers[p.entry.op.fn]
					if (!reducer && (p.entry.op.fn === "set" || p.entry.op.fn === "delete")) {
						if (p.entry.op.fn === "set") reducer = (db: any, k: any, v: any) => db.set(k, v)
						if (p.entry.op.fn === "delete") reducer = (db: any, k: any) => db.delete(k)
					}
					if (!reducer) continue

					const writes: WriteArgs<any, any> = { set: [], delete: [] }
					const proxyTx = this.createProxyTx(writes)
					const contextTx = Object.create(proxyTx)
					contextTx.syncMetadata = p.entry.metadata
					reducer(contextTx, ...p.entry.op.args)

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

	handleSyncResponse(serverClock: number, updates: SyncHistoryEntry[]) {
		for (const p of this.pendingOps) {
			p.cleanup()
		}

		this.syncedClock = serverClock
		this.manager.db.set([...this.prefix, "clock"], this.syncedClock)

		for (const entry of updates) {
			this.applyServerUpdate(entry)
		}
	}

	applyServerUpdate(entry: SyncHistoryEntry) {
		let reducer = this.manager.reducers[entry.op.fn]
		if (!reducer && (entry.op.fn === "set" || entry.op.fn === "delete")) {
			if (entry.op.fn === "set") reducer = (db: any, k: any, v: any) => db.set(k, v)
			if (entry.op.fn === "delete") reducer = (db: any, k: any) => db.delete(k)
		}
		
		if (!reducer) {
			console.warn(`Unknown reducer from server: ${entry.op.fn}`)
			return
		}

		const writes: WriteArgs<any, any> = { set: [], delete: [] }
		const proxyTx = this.createProxyTx(writes) 
		const contextTx = Object.create(proxyTx)
		contextTx.syncMetadata = entry.metadata
		reducer(contextTx, ...entry.op.args)
		const scopedWrites = this.filterWrites(writes)
		
		this.manager.db.write(scopedWrites)
		this.manager.cache.apply(scopedWrites)
	}
}