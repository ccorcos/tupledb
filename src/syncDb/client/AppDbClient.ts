import { applyCommit } from "syncDb/appDb"
import { randomId } from "../../shared/randomId"
import { codec } from "../../tupleDb/Codec"
import { EncodeSubspaceListArgs, KeyDecodeList, KeyEncodeRange, TupleSubspaceEncoder } from "../../tupleDb/Encoder"
import { OkvCache } from "../../tupleDb/OkvCache"
import { optimisticList, OptimisticListResult } from "../../tupleDb/OptimisticOkv"
import { Range } from "../../tupleDb/Range"
import { Transaction } from "../../tupleDb/Transaction"
import { tupleDb } from "../../tupleDb/TupleDb"
import { JSONValue, ListArgs, Tuple, WriteArgs } from "../../tupleDb/types"
import { Commit, Op, ReducerMap } from "../types"
import { AppDbClientOptions, AppServerApi, ConfirmedCommit, PendingCommit, PubsubApi } from "./types"

export type LocalResult<T> = {
	hit?: T[]
	miss?: T[]
	prefix?: T[]
}

export class AppDbClient<R extends ReducerMap = ReducerMap> {
	readonly reducers: R
	readonly authorId?: string

	private server: AppServerApi
	private pubsub: PubsubApi
	private baseCache: OkvCache<Tuple, JSONValue>
	private pendingCommits: PendingCommit<R>[] = []
	private localSeqCounter = 0
	private scopeFetching = new Map<string, Promise<void>>()
	private rangeFetching = new Map<string, Promise<void>>()
	private stateListeners = new Set<() => void>()
	private unsubscribePubsub?: () => void
	private scopeRefs = new Map<string, number>()

	constructor(options: AppDbClientOptions<R>) {
		this.server = options.server
		this.pubsub = options.pubsub
		this.reducers = options.reducers
		this.authorId = options.authorId
		this.baseCache = new OkvCache<Tuple, JSONValue>(codec.compare)

		this.unsubscribePubsub = this.pubsub.onMessage((key, value) => {
			this.handleClockUpdate(key, value as number)
		})
	}

	private incSyncDb(path: Tuple): void {
		const key = JSON.stringify(path)
		const count = this.scopeRefs.get(key) ?? 0

		if (count === 0) {
			this.pubsub.subscribe(key)
			this.syncScope(path).catch(() => { })
		}

		this.scopeRefs.set(key, count + 1)
	}

	private decSyncDb(path: Tuple): void {
		const key = JSON.stringify(path)
		const count = this.scopeRefs.get(key) ?? 0
		if (count <= 1) {
			this.scopeRefs.delete(key)
			this.pubsub.unsubscribe(key)
		} else {
			this.scopeRefs.set(key, count - 1)
		}
	}

	syncDb(path: Tuple): SyncDbClient {
		this.incSyncDb(path)

		const dataPrefix = [...path, "data"]
		const encoder = TupleSubspaceEncoder(dataPrefix)
		const syncDb: SyncDbClient = {
			path,
			destroy: () => this.decSyncDb(path),
			clock: () => tupleDb(this.baseCache.data).subspace(path).get(["clock"]) ?? 0,

			list: (args) => {
				const fullArgs = EncodeSubspaceListArgs(args ?? {}, dataPrefix)
				const result = this.list(fullArgs)

				const local: LocalResult<{ key: Tuple; value: JSONValue }> = {}
				if (result.hit) local.hit = KeyDecodeList(result.hit, encoder)
				else if (result.prefix) local.prefix = KeyDecodeList(result.prefix, encoder)
				else local.miss = KeyDecodeList(result.miss ?? [], encoder)

				const isHit = result.hit !== undefined
				const remote = isHit
					? Promise.resolve()
					: this.fetchRange(path, args ?? {})

				return { local, remote }
			},

			get: (key) => {
				const result = syncDb.list({ gte: key, lte: key })
				const data = result.local.hit ?? result.local.prefix ?? result.local.miss ?? []
				return data.at(0)?.value
			},

			subscribe: (range, fn) => {
				const fullRange = KeyEncodeRange(range, encoder)
				return this.subscribe(fullRange, fn)
			},

			subspace: (prefix) => createSyncDbView(syncDb, prefix),

			sync: () => this.syncScope(path),
		}
		return syncDb
	}

	getPendingCommits(): readonly PendingCommit<R>[] {
		return this.pendingCommits
	}

	list(args?: ListArgs<Tuple>): OptimisticListResult<Tuple, JSONValue> {
		const pendingWrites = this.pendingCommits.map(p => p.writes)
		return optimisticList(this.baseCache, pendingWrites, codec.compare, args)
	}

	commit(ops: Op<R>[]): void {
		const id = randomId()
		const createdAt = new Date().toISOString()
		const pending: PendingCommit<R> = {
			id,
			authorId: this.authorId,
			createdAt,
			ops,
			writes: { set: [], delete: [] },
			localSeq: ++this.localSeqCounter,
			status: "pending",
		}

		pending.writes = this.captureWrites(pending)
		this.pendingCommits.push(pending)
		this.notifyStateChange()
		this.emitDataChanges()

		this.syncInBackground(pending)
	}

	async flush(): Promise<void> {
		while (this.pendingCommits.some((c) => c.status === "pending" || c.status === "submitting")) {
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
	}

	private captureWrites(commit: PendingCommit<R>): WriteArgs<Tuple, JSONValue> {
		const mergedView = this.createMergedView()
		const tempTx = new Transaction(mergedView)
		const meta = { id: commit.id, authorId: commit.authorId, createdAt: commit.createdAt }
		applyCommit(tupleDb(tempTx), this.reducers, meta, commit.ops)

		return {
			set: tempTx.pending.set.list(),
			delete: tempTx.pending.delete.list().map(({ key }) => key),
		}
	}

	private createMergedView() {
		const pendingWrites = this.pendingCommits.map(p => p.writes)
		const baseData = this.baseCache.data
		const compare = codec.compare

		return {
			compare,
			list: (args?: ListArgs<Tuple>) => {
				let data = baseData.list(args)
				for (const writes of pendingWrites) {
					data = this.applyWritesToData(data, writes, compare, args)
				}
				return data
			},
			write: () => {
				throw new Error("MergedView is read-only")
			},
		}
	}

	private applyWritesToData(
		data: { key: Tuple; value: JSONValue }[],
		writes: WriteArgs<Tuple, JSONValue>,
		compare: (a: Tuple, b: Tuple) => number,
		args?: ListArgs<Tuple>
	): { key: Tuple; value: JSONValue }[] {
		let result = [...data]

		if (writes.delete) {
			result = result.filter(
				(item) => !writes.delete!.some((k) => compare(item.key, k) === 0)
			)
		}

		if (writes.set) {
			for (const { key, value } of writes.set) {
				if (!this.keyInRange(key, compare, args)) continue

				const idx = result.findIndex((item) => compare(item.key, key) === 0)
				if (idx !== -1) {
					result[idx] = { key, value }
				} else {
					const insertIdx = result.findIndex(
						(item) => compare(item.key, key) > 0
					)
					if (insertIdx === -1) result.push({ key, value })
					else result.splice(insertIdx, 0, { key, value })
				}
			}
		}

		return result
	}

	private keyInRange(key: Tuple, compare: (a: Tuple, b: Tuple) => number, args?: ListArgs<Tuple>): boolean {
		if (!args) return true
		if (args.gt && compare(key, args.gt) <= 0) return false
		if (args.gte && compare(key, args.gte) < 0) return false
		if (args.lt && compare(key, args.lt) >= 0) return false
		if (args.lte && compare(key, args.lte) > 0) return false
		return true
	}

	private async syncInBackground(pending: PendingCommit<R>): Promise<void> {
		try {
			pending.status = "submitting"
			this.notifyStateChange()

			await this.server.write({
				id: pending.id,
				authorId: pending.authorId,
				createdAt: pending.createdAt,
				ops: pending.ops as { fn: string; args: any[] }[],
			})

			pending.status = "submitted"
			this.notifyStateChange()

			this.baseCache.data.write(pending.writes)
			this.removePendingCommit(pending.id)
			this.notifyStateChange()
			this.emitDataChanges()
		} catch (error) {
			pending.status = "failed"
			pending.error = error instanceof Error ? error.message : String(error)
			this.notifyStateChange()
		}
	}

	retryCommit(commitId: string): void {
		const pending = this.pendingCommits.find((c) => c.id === commitId)
		if (!pending) throw new Error(`Commit not found: ${commitId}`)
		if (pending.status !== "failed") throw new Error(`Commit is not failed: ${commitId}`)
		pending.status = "pending"
		pending.error = undefined
		this.notifyStateChange()
		this.emitDataChanges()

		this.syncInBackground(pending)
	}

	cancelCommit(commitId: string): void {
		const index = this.pendingCommits.findIndex((c) => c.id === commitId)
		if (index === -1) throw new Error(`Commit not found: ${commitId}`)
		const pending = this.pendingCommits[index]
		if (pending.status !== "failed") throw new Error(`Can only cancel failed commits: ${commitId}`)
		this.pendingCommits.splice(index, 1)
		this.notifyStateChange()
		this.emitDataChanges()
	}

	async syncScope(path: Tuple): Promise<void> {
		const key = JSON.stringify(path)
		const existing = this.scopeFetching.get(key)
		if (existing) return existing

		const promise = this._syncScopeImpl(path).finally(() => {
			this.scopeFetching.delete(key)
		})
		this.scopeFetching.set(key, promise)
		return promise
	}

	fetchRange(path: Tuple, args: ListArgs<Tuple>): Promise<void> {
		const key = JSON.stringify({ path, args })
		const existing = this.rangeFetching.get(key)
		if (existing) return existing

		const promise = this._fetchRangeImpl(path, args).finally(() => {
			this.rangeFetching.delete(key)
		})
		this.rangeFetching.set(key, promise)
		return promise
	}

	private async _fetchRangeImpl(path: Tuple, args: ListArgs<Tuple>): Promise<void> {
		const dataResult = await this.server.list(path, args)
		const dataPrefix = [...path, "data"]
		const upperBound = [...dataPrefix, ...Array(10).fill(null)]

		this.baseCache.insert([{
			args: { gte: dataPrefix, lte: upperBound },
			result: dataResult.data.map(({ key, value }) => ({
				key: [...path, ...key],
				value,
			})),
		}])

		const newClock = dataResult.clock
		const currentClock = this.getClock(path)
		if (newClock > currentClock) {
			this.baseCache.data.write({ set: [{ key: [...path, "clock"], value: newClock }] })
		}
	}

	private async _syncScopeImpl(path: Tuple): Promise<void> {
		const currentClock = this.getClock(path)
		const historyResult = await this.server.history(path, currentClock)
		const dataResult = await this.server.list(path, {})

		for (const commit of historyResult.commits) {
			const wasPending = this.pendingCommits.some((p) => p.id === commit.id)
			const confirmed: ConfirmedCommit<R> = { ...(commit as Commit<R>), isLocal: wasPending }
			this.baseCache.data.write({ set: [{ key: [...path, "history", commit.clock], value: confirmed }] })
			if (wasPending) {
				this.removePendingCommit(commit.id)
			}
		}

		const dataPrefix = [...path, "data"]
		this.baseCache.data.write({
			set: dataResult.data.map(({ key, value }) => ({
				key: [...path, ...key],
				value,
			})),
		})

		const newClock = Math.max(currentClock, historyResult.clock, dataResult.clock)
		this.baseCache.data.write({ set: [{ key: [...path, "clock"], value: newClock }] })

		const upperBound = [...dataPrefix, ...Array(10).fill(null)]
		this.baseCache.insert([
			{
				args: { gte: dataPrefix, lte: upperBound },
				result: dataResult.data.map(({ key, value }) => ({
					key: [...path, ...key],
					value,
				})),
			},
		])

		this.emitDataChanges()
	}

	getClock(path: Tuple): number {
		const result = this.baseCache.data.list({ gte: [...path, "clock"], lte: [...path, "clock"] })
		return (result.at(0)?.value as number) || 0
	}

	subscribe(range: { gte?: Tuple; lte?: Tuple; gt?: Tuple; lt?: Tuple }, fn: () => void): () => void {
		return this.baseCache.subscribe(range, fn)
	}

	onStateChange(fn: () => void): () => void {
		this.stateListeners.add(fn)
		return () => this.stateListeners.delete(fn)
	}

	dispose(): void {
		if (this.unsubscribePubsub) {
			this.unsubscribePubsub()
		}
		for (const key of this.scopeRefs.keys()) {
			this.pubsub.unsubscribe(key)
		}
		this.stateListeners.clear()
	}

	private removePendingCommit(id: string): void {
		const index = this.pendingCommits.findIndex((c) => c.id === id)
		if (index !== -1) {
			this.pendingCommits.splice(index, 1)
		}
	}

	private async handleClockUpdate(key: string, newClock: number): Promise<void> {
		if (!this.scopeRefs.has(key)) return
		const path = JSON.parse(key) as Tuple
		const currentClock = this.getClock(path)
		if (newClock <= currentClock) return
		await this.syncScope(path)
	}

	private notifyStateChange(): void {
		for (const listener of this.stateListeners) {
			listener()
		}
	}

	private emitDataChanges(): void {
		this.baseCache.emit([{}])
	}
}

export type SyncDbClientView = {
	list(args?: ListArgs<Tuple>): {
		local: LocalResult<{ key: Tuple; value: JSONValue }>
		remote: Promise<void>
	}
	get(key: Tuple): JSONValue | undefined
	subscribe(range: Range<Tuple>, fn: () => void): () => void
	subspace(prefix: Tuple): SyncDbClientView
}

export type SyncDbClient = SyncDbClientView & {
	readonly path: Tuple
	destroy(): void
	clock(): number
	sync(): Promise<void>
}


function createSyncDbView(parent: SyncDbClientView, prefix: Tuple): SyncDbClientView {
	const encoder = TupleSubspaceEncoder(prefix)

	return {
		list: (args) => {
			const result = parent.list(EncodeSubspaceListArgs(args ?? {}, prefix))
			const local: LocalResult<{ key: Tuple; value: JSONValue }> = {}

			if (result.local.hit) local.hit = KeyDecodeList(result.local.hit, encoder)
			else if (result.local.prefix) local.prefix = KeyDecodeList(result.local.prefix, encoder)
			else local.miss = KeyDecodeList(result.local.miss ?? [], encoder)

			return { local, remote: result.remote }
		},
		get: (key) => {
			const result = parent.list({ gte: [...prefix, ...key], lte: [...prefix, ...key] })
			const data = result.local.hit ?? result.local.prefix ?? result.local.miss ?? []
			return data.at(0)?.value
		},
		subspace: (subPrefix) => createSyncDbView(parent, [...prefix, ...subPrefix]),
		subscribe: (range, fn) => parent.subscribe(KeyEncodeRange(range, encoder), fn),
	}
}
