import { Cache } from "../Cache"
import { TupleSubspaceEncoder } from "../Encoder"
import { tupleTx } from "../TupleDb"
import { TupleDb, TupleTx, WriteArgs } from "../types"
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
	pendingOps: { op: Operation; cleanup: () => void }[] = []
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

		// 1. Optimistic Apply to Cache
		const reducer = this.manager.reducers[fn]
		if (!reducer) throw new Error("Unknown reducer")

		// Capture writes
		const writes: WriteArgs<any, any> = { set: [], delete: [] }
		const proxyTx = this.createProxyTx(writes)

		reducer(proxyTx, ...args)

		// Apply to Cache (Optimistic)
		// We need to prefix the writes with [...prefix, "data"] before writing to cache
		const prefixedWrites = this.prefixWrites(writes)
		const cleanup = this.manager.cache.write(prefixedWrites)

		// Queue
		this.pendingOps.push({ op, cleanup })

		// Trigger sync
		this.sync()
	}

	prefixWrites(writes: WriteArgs<any, any>): WriteArgs<any, any> {
		// Prefix everything with [...this.prefix, "data"]
		// But wait, the reducer might already be writing to the intended keys relative to the "root".
		// We assume reducers are written assuming they run on a DB.
		// If we are "user/1", and reducer writes "inbox", we want "user/1/data/inbox".
		const dataPrefix = [...this.prefix, "data"]
		return {
			set: writes.set?.map(({ key, value }) => ({
				key: [...dataPrefix, ...key],
				value,
			})),
			delete: writes.delete?.map((key) => [...dataPrefix, ...key]),
		}
	}

	// This is a proxy for the REDUCER running OPTIMISTICALLY.
	// It writes to a capture buffer.
	createProxyTx(writes: WriteArgs<any, any>): TupleTx {
		return {
			compare: this.manager.db.compare,
			set: (key: any, value: any) => {
				writes.set?.push({ key, value })
			},
			delete: (key: any) => {
				writes.delete?.push(key)
			},
			get: (key: any) => {
				// Read from GLOBAL cache using PREFIXED key
				const prefixedKey = [...this.prefix, "data", ...key]
				const res = this.manager.cache.list({ gte: prefixedKey, lte: prefixedKey })
				return res.hit?.[0]?.value
			},
			list: (args: any) => {
				// List from GLOBAL cache using PREFIXED range
				// We need a helper to prefix ListArgs
				// EncodeSubspaceListArgs logic
				// For now simple approximation:
				const dataPrefix = [...this.prefix, "data"]
				// const prefixedArgs = ...
				// This is getting complex to implement perfectly inside `createProxyTx`.
				// Ideally we reuse `TupleSubspaceEncoder`.
				const encoder = TupleSubspaceEncoder(dataPrefix)
				// We need to manually encode args.
				// But we don't have EncodeSubspaceListArgs imported here efficiently?
				// Let's assume list() is not heavily used in optimistic reducers or implement basic support.
				return [] // TODO: Implement list read for optimistic reducers
			},
			write: () => {
				throw new Error("Nested write not supported in reducer proxy")
			},
			commit: () => {},
			committed: false,
			has: (key: any) => {
				const prefixedKey = [...this.prefix, "data", ...key]
				return !!this.manager.cache.list({ gte: prefixedKey, lte: prefixedKey }).hit?.length
			},
			subspace: (p: any) => {
				throw new Error("Subspace not supported in reducer proxy yet")
			},
		} as unknown as TupleTx
	}

	async sync() {
		if (this.pendingOps.length === 0) {
			// Just pull?
		}

		const opsToSend = this.pendingOps.map((p) => p.op)

		try {
			const res = await this.manager.transport(this.prefix, {
				ops: opsToSend,
				syncedClock: this.syncedClock,
			})

			// Success!
			// 1. Update Clock
			this.syncedClock = res.serverClock
			this.manager.db.set([...this.prefix, "clock"], this.syncedClock)

			// 2. Undo ALL pending ops (Clean slate)
			for (const p of this.pendingOps) {
				p.cleanup()
			}

			// 3. Apply `newOps` (from server) to DB + Cache Base
			for (const op of res.newOps) {
				this.applyServerOp(op)
			}

			// 4. Determine remaining pending ops
			const confirmedIds = new Set(opsToSend.map((o) => o.id))
			const remainingOps = this.pendingOps.map((p) => p.op).filter((op) => !confirmedIds.has(op.id))

			this.pendingOps = []

			// 5. Re-apply remaining ops
			for (const op of remainingOps) {
				const reducer = this.manager.reducers[op.fn]
				if (!reducer) continue

				const writes: WriteArgs<any, any> = { set: [], delete: [] }
				const proxyTx = this.createProxyTx(writes)
				reducer(proxyTx, ...op.args)

				const prefixedWrites = this.prefixWrites(writes)
				const cleanup = this.manager.cache.write(prefixedWrites)
				this.pendingOps.push({ op, cleanup })
			}
		} catch (e) {
			console.error("Sync failed", e)
		}
	}

	applyServerOp(op: Operation) {
		const reducer = this.manager.reducers[op.fn]
		if (!reducer) return

		const tx = tupleTx(this.manager.db)

		// This proxy applies writes to the GLOBAL DB and CACHE using the "data" subspace.
		// Since we are inside a SyncSession for a specific prefix, we implicitly prune/filter
		// by virtue of only applying writes that this session cares about?
		// No, the reducer logic might be generic.
		// "sendMessage" reducer writes "inbox/1".
		// In the context of `SyncSession(["user", 1])`, this becomes `["user", 1, "data", "inbox", 1]`.

		// So we always prefix with `[...prefix, "data"]`.
		const dataPrefix = [...this.prefix, "data"]

		const wrappingTx = {
			...tx,
			set: (key: any, value: any) => {
				const fullKey = [...dataPrefix, ...key]
				tx.set(fullKey, value)
				this.manager.cache.data.write({ set: [{ key: fullKey, value }] })
			},
			delete: (key: any) => {
				const fullKey = [...dataPrefix, ...key]
				tx.delete(fullKey)
				this.manager.cache.data.write({ delete: [fullKey] })
			},
			// Reads need to be prefixed too?
			// Ideally reducers read from the transaction which sees the "data" view.
			get: (k: any) => tx.get([...dataPrefix, ...k]),
			list: (args: any) => [], // TODO: support list inside reducer
			has: (k: any) => tx.has([...dataPrefix, ...k]),
			write: (args: WriteArgs<any, any>) => {
				// Prefix manual writes
				const sets = args.set?.map(({ key, value }) => ({
					key: [...dataPrefix, ...key],
					value,
				}))
				const deletes = args.delete?.map((key) => [...dataPrefix, ...key])
				tx.write({ set: sets, delete: deletes })
				this.manager.cache.data.write({ set: sets, delete: deletes })
			},
			subspace: (p: any) => {
				throw new Error("Subspace not implemented in pruning proxy")
			},
		} as unknown as TupleTx

		reducer(wrappingTx, ...op.args)

		tx.commit()
	}
}