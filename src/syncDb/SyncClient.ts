import { Cache } from "../tupleDb/Cache"
import { TupleDb, TupleTx, WriteArgs, ListArgs, Tuple } from "../tupleDb/types"
import { defaultReducers } from "./SyncDb"
import { SyncManagerConfig, Commit, Op, WriteResult, ReducerMap } from "./types"
import { randomId } from "../shared/randomId"

export type { SyncManagerConfig } from "./types"

export class SyncManager {
	db: TupleDb
	reducers: ReducerMap
	transport: any
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

type PendingCommit = {
    commit: Commit
    cleanup: () => void
    changes: WriteArgs<any, any>
}

export class SyncSession {
	pendingCommits: PendingCommit[] = []
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

	dispatch(fn: string, args: any) {
		const op: Op = { fn, args }
        const now = new Date().toISOString()
		const commit: Commit = { 
			id: randomId(),
            clock: 0, // Will be assigned by server. Local placeholder.
            commitedAt: now,
            createdAt: now,
            ops: [op]
		}

		let reducer = this.manager.reducers[fn] || (defaultReducers as any)[fn]
		if (!reducer) throw new Error(`Unknown reducer: ${fn}`)

		const writes: WriteArgs<any, any> = { set: [], delete: [] }
		const proxyTx = this.createProxyTx(writes)
        const context = Object.create(proxyTx)
        context.syncMetadata = commit
        // Reducer signature is (tx, args).
		reducer(context, args)

		const scopedWrites = this.filterWrites(writes)
		const cleanup = this.manager.cache.write(scopedWrites)

		this.pendingCommits.push({ 
			commit, 
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
				const commitsToSend = this.pendingCommits.map((p) => p.commit)
				if (commitsToSend.length === 0) break

				const res = await this.manager.transport.sync(
					this.prefix, 
					commitsToSend, 
					this.syncedClock
				)

				this.handleSyncResponse(res.clock, res.updates)
				
				const confirmedIds = new Set(res.updates.map((u) => u.id).filter(Boolean))
				const remaining = this.pendingCommits.filter(p => !confirmedIds.has(p.commit.id))
				this.pendingCommits = []

				for (const p of remaining) {
					// Re-apply optimistic
                    // Iterate ops
                    const writes: WriteArgs<any, any> = { set: [], delete: [] }
                    
                    for (const op of p.commit.ops) {
                        let reducer = this.manager.reducers[op.fn] || (defaultReducers as any)[op.fn]
                        if (!reducer) continue

                        const proxyTx = this.createProxyTx(writes)
                        const context = Object.create(proxyTx)
                        context.syncMetadata = p.commit
                        reducer(context, op.args)
                    }

					const scopedWrites = this.filterWrites(writes)
					const cleanup = this.manager.cache.write(scopedWrites)
					this.pendingCommits.push({ commit: p.commit, cleanup, changes: scopedWrites })
				}

				if (remaining.length === commitsToSend.length) break
				if (this.pendingCommits.length === 0) break
			}
		} catch (e) {
			console.error("Sync failed", e)
		} finally {
			this.isSyncing = false
		}
	}

	handleSyncResponse(serverClock: number, updates: Commit[]) {
		for (const p of this.pendingCommits) {
			p.cleanup()
		}

		this.syncedClock = serverClock
		this.manager.db.set([...this.prefix, "clock"], this.syncedClock)

		for (const commit of updates) {
			this.applyServerUpdate(commit)
		}
	}

	applyServerUpdate(commit: Commit) {
        const writes: WriteArgs<any, any> = { set: [], delete: [] }
        const proxyTx = this.createProxyTx(writes)
        
        for (const op of commit.ops) {
            let reducer = this.manager.reducers[op.fn] || (defaultReducers as any)[op.fn]
            if (!reducer) {
                console.warn(`Unknown reducer from server: ${op.fn}`)
                continue
            }
            const context = Object.create(proxyTx)
            context.syncMetadata = commit
            reducer(context, op.args)
        }
        
		const scopedWrites = this.filterWrites(writes)
		
		this.manager.db.write(scopedWrites)
		this.manager.cache.apply(scopedWrites)
	}
}