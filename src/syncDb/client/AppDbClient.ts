import { applyCommit } from "syncDb/appDb"
import { randomId } from "../../shared/randomId"
import { codec } from "../../tupleDb/Codec"
import { OkvCache } from "../../tupleDb/OkvCache"
import { Transaction } from "../../tupleDb/Transaction"
import { tupleDb } from "../../tupleDb/TupleDb"
import { JSONValue, ListArgs, Tuple } from "../../tupleDb/types"
import { Commit, Op, ReducerMap } from "../types"
import { SyncDbClient } from "./SyncDbClient"
import { AppDbClientOptions, AppServerApi, ConfirmedCommit, PendingCommit, PubsubApi } from "./types"

export class AppDbClient<R extends ReducerMap = ReducerMap> {
	readonly reducers: R
	readonly authorId?: string

	private server: AppServerApi
	private pubsub: PubsubApi
	private cache: OkvCache<Tuple, JSONValue>
	private optimisticTx: Transaction<Tuple, JSONValue>
	private pendingCommits: PendingCommit<R>[] = []
	private localSeqCounter = 0
	private scopeFetching = new Map<string, Promise<void>>()
	private stateListeners = new Set<() => void>()
	private unsubscribePubsub?: () => void
	private subscribedScopes = new Set<string>()

	constructor(options: AppDbClientOptions<R>) {
		this.server = options.server
		this.pubsub = options.pubsub
		this.reducers = options.reducers
		this.authorId = options.authorId
		this.cache = new OkvCache<Tuple, JSONValue>(codec.compare)
		this.optimisticTx = new Transaction(this.cache.data)

		this.unsubscribePubsub = this.pubsub.onMessage((key, value) => {
			this.handleClockUpdate(key, value as number)
		})
	}

	getSyncDb(path: Tuple): SyncDbClient<R> {
		return new SyncDbClient(this, path)
	}

	getPendingCommits(): readonly PendingCommit<R>[] {
		return this.pendingCommits
	}

	list(args?: ListArgs<Tuple>): { key: Tuple; value: JSONValue }[] {
		return this.optimisticTx.list(args)
	}

	commit(ops: Op<R>[]): void {
		const id = randomId()
		const createdAt = new Date().toISOString()
		const pending: PendingCommit<R> = {
			id,
			authorId: this.authorId,
			createdAt,
			ops,
			localSeq: ++this.localSeqCounter,
			status: "pending",
		}

		this.applyOptimistic(pending)
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

			this.applyToConfirmed(pending)
			this.removePendingCommit(pending.id)
			this.rebuildOptimisticState()
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
		this.rebuildOptimisticState()
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
		this.rebuildOptimisticState()
		this.notifyStateChange()
		this.emitDataChanges()
	}

	async initializeScope(path: Tuple): Promise<void> {
		const key = JSON.stringify(path)
		if (this.subscribedScopes.has(key)) return

		this.pubsub.subscribe(key)
		this.subscribedScopes.add(key)
		await this.syncScope(path)
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

	private async _syncScopeImpl(path: Tuple): Promise<void> {
		const currentClock = this.getClock(path)
		const historyResult = await this.server.history(path, currentClock)
		const dataResult = await this.server.list(path, {})

		for (const commit of historyResult.commits) {
			const wasPending = this.pendingCommits.some((p) => p.id === commit.id)
			const confirmed: ConfirmedCommit<R> = { ...(commit as Commit<R>), isLocal: wasPending }
			this.cache.data.write({ set: [{ key: [...path, "history", commit.clock], value: confirmed }] })
			if (wasPending) {
				this.removePendingCommit(commit.id)
			}
		}

		const dataPrefix = [...path, "data"]
		const existingData = this.cache.data.list({
			gte: dataPrefix,
			lte: [...dataPrefix, []],
		})
		this.cache.data.write({ delete: existingData.map(({ key }) => key) })
		this.cache.data.write({
			set: dataResult.data.map(({ key, value }) => ({
				key: [...path, ...key],
				value,
			})),
		})

		const newClock = Math.max(currentClock, historyResult.clock, dataResult.clock)
		this.cache.data.write({ set: [{ key: [...path, "clock"], value: newClock }] })

		this.cache.insert([
			{
				args: { gte: dataPrefix, lte: [...dataPrefix, []] },
				result: dataResult.data.map(({ key, value }) => ({
					key: [...path, ...key],
					value,
				})),
			},
		])

		this.rebuildOptimisticState()
		this.emitDataChanges()
	}

	getClock(path: Tuple): number {
		const result = this.cache.data.list({ gte: [...path, "clock"], lte: [...path, "clock"] })
		return (result.at(0)?.value as number) || 0
	}

	subscribe(range: { gte?: Tuple; lte?: Tuple; gt?: Tuple; lt?: Tuple }, fn: () => void): () => void {
		return this.cache.subscribe(range, fn)
	}

	onStateChange(fn: () => void): () => void {
		this.stateListeners.add(fn)
		return () => this.stateListeners.delete(fn)
	}

	dispose(): void {
		if (this.unsubscribePubsub) {
			this.unsubscribePubsub()
		}
		for (const key of this.subscribedScopes) {
			this.pubsub.unsubscribe(key)
		}
		this.stateListeners.clear()
	}

	// Internal methods used by SyncDbClient

	_getCache(): OkvCache<Tuple, JSONValue> {
		return this.cache
	}

	_getOptimisticTx(): Transaction<Tuple, JSONValue> {
		return this.optimisticTx
	}

	private applyOptimistic(commit: PendingCommit<R>): void {
		const meta = { id: commit.id, authorId: commit.authorId, createdAt: commit.createdAt }
		const db = tupleDb(this.optimisticTx)
		applyCommit(db, this.reducers, meta, commit.ops)
	}

	private applyToConfirmed(commit: PendingCommit<R>): void {
		const meta = { id: commit.id, authorId: commit.authorId, createdAt: commit.createdAt }
		const db = tupleDb(this.cache.data)
		applyCommit(db, this.reducers, meta, commit.ops)
	}

	private removePendingCommit(id: string): void {
		const index = this.pendingCommits.findIndex((c) => c.id === id)
		if (index !== -1) {
			this.pendingCommits.splice(index, 1)
		}
	}

	private rebuildOptimisticState(): void {
		this.optimisticTx = new Transaction(this.cache.data)
		for (const commit of this.pendingCommits) {
			if (commit.status !== "failed") {
				this.applyOptimistic(commit)
			}
		}
	}

	private async handleClockUpdate(key: string, newClock: number): Promise<void> {
		if (!this.subscribedScopes.has(key)) return
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
		this.cache.emit([{}])
	}
}
