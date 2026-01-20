import { randomId } from "../../shared/randomId"
import { codec } from "../../tupleDb/Codec"
import { InMemoryOkv } from "../../tupleDb/InMemoryOkv"
import { OkvCache } from "../../tupleDb/OkvCache"
import { Transaction } from "../../tupleDb/Transaction"
import { tupleDb } from "../../tupleDb/TupleDb"
import { JSONValue, ListArgs, Tuple, TupleDb, WriteArgs } from "../../tupleDb/types"
import { Commit, CommitMeta, Op, ReducerMap } from "../types"
import { SyncDbClient } from "./SyncDbClient"
import {
	AppDbClientOptions,
	AppServerApi,
	ConfirmedCommit,
	PendingCommit,
	PubsubApi,
	ScopeState,
} from "./types"

function defaultScopeState(): ScopeState {
	return {
		confirmedClock: 0,
		initialized: false,
		fetching: false,
		connectionStatus: "disconnected",
	}
}

function encodeSubspaceArgs(args: ListArgs<Tuple>, prefix: Tuple): ListArgs<Tuple> {
	return {
		...args,
		gt: args.gt ? [...prefix, ...args.gt] : undefined,
		gte: args.gte ? [...prefix, ...args.gte] : args.gt ? undefined : prefix,
		lt: args.lt ? [...prefix, ...args.lt] : undefined,
		lte: args.lte ? [...prefix, ...args.lte] : args.lt ? undefined : [...prefix, []],
	}
}

function decodeSubspaceResult(
	result: { key: Tuple; value: JSONValue }[],
	prefix: Tuple
): { key: Tuple; value: JSONValue }[] {
	return result.map(({ key, value }) => ({
		key: key.slice(prefix.length),
		value,
	}))
}

function encodeSubspaceWrite(
	args: WriteArgs<Tuple, JSONValue>,
	prefix: Tuple
): WriteArgs<Tuple, JSONValue> {
	return {
		set: args.set?.map(({ key, value }) => ({ key: [...prefix, ...key], value })),
		delete: args.delete?.map((key) => [...prefix, ...key]),
	}
}

export class AppDbClient<R extends ReducerMap = ReducerMap> {
	readonly reducers: R
	readonly authorId?: string

	private server: AppServerApi
	private pubsub: PubsubApi
	private data: InMemoryOkv<Tuple, JSONValue>
	private cache: OkvCache<Tuple, JSONValue>
	private optimisticTx: Transaction<Tuple, JSONValue>
	private pendingCommits: PendingCommit<R>[] = []
	private localSeqCounter = 0
	private scopes = new Map<string, ScopeState>()
	private scopeHistory = new Map<string, InMemoryOkv<number, ConfirmedCommit<R>>>()
	private stateListeners = new Set<() => void>()
	private scopeListeners = new Map<string, Set<() => void>>()
	private unsubscribePubsub?: () => void
	private subscribedScopes = new Set<string>()

	constructor(options: AppDbClientOptions<R>) {
		this.server = options.server
		this.pubsub = options.pubsub
		this.reducers = options.reducers
		this.authorId = options.authorId
		this.data = new InMemoryOkv<Tuple, JSONValue>(codec.compare)
		this.cache = new OkvCache<Tuple, JSONValue>(codec.compare)
		this.optimisticTx = new Transaction(this.data)

		this.unsubscribePubsub = this.pubsub.onMessage((key, value) => {
			this.handleClockUpdate(key, value as number)
		})
	}

	getSyncDb(path: Tuple): SyncDbClient<R> {
		return new SyncDbClient(this, path)
	}

	getState(path: Tuple): Readonly<ScopeState> {
		const key = JSON.stringify(path)
		return this.scopes.get(key) ?? defaultScopeState()
	}

	getPendingCommits(): readonly PendingCommit<R>[] {
		return this.pendingCommits
	}

	list(args?: ListArgs<Tuple>): { key: Tuple; value: JSONValue }[] {
		return this.optimisticTx.list(args)
	}

	async commit(ops: Op<R>[]): Promise<void> {
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

		this.applyCommitOptimistically(pending)
		this.pendingCommits.push(pending)
		this.notifyStateChange()
		this.emitDataChanges()

		try {
			pending.status = "submitting"
			await this.server.write({
				id: pending.id,
				authorId: pending.authorId,
				createdAt: pending.createdAt,
				ops: pending.ops as { fn: string; args: any[] }[],
			})
			this.applyCommitToConfirmedData(pending)
			this.removePendingCommit(pending.id)
			this.rebuildOptimisticState()
			this.notifyStateChange()
			this.emitDataChanges()
		} catch (error) {
			pending.status = "failed"
			pending.error = error instanceof Error ? error.message : String(error)
			this.notifyStateChange()
			throw error
		}
	}

	async retryCommit(commitId: string): Promise<void> {
		const pending = this.pendingCommits.find((c) => c.id === commitId)
		if (!pending) throw new Error(`Commit not found: ${commitId}`)
		if (pending.status !== "failed") throw new Error(`Commit is not failed: ${commitId}`)
		pending.status = "pending"
		pending.error = undefined

		try {
			pending.status = "submitting"
			await this.server.write({
				id: pending.id,
				authorId: pending.authorId,
				createdAt: pending.createdAt,
				ops: pending.ops as { fn: string; args: any[] }[],
			})
			this.applyCommitToConfirmedData(pending)
			this.removePendingCommit(pending.id)
			this.rebuildOptimisticState()
			this.notifyStateChange()
			this.emitDataChanges()
		} catch (error) {
			pending.status = "failed"
			pending.error = error instanceof Error ? error.message : String(error)
			this.notifyStateChange()
			throw error
		}
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
		const state = this.scopes.get(key)
		if (state?.initialized) return

		this.pubsub.subscribe(key)
		this.subscribedScopes.add(key)

		this.updateScopeState(path, { connectionStatus: "connected" })
		await this.syncScope(path)
		this.updateScopeState(path, { initialized: true })
	}

	async syncScope(path: Tuple): Promise<void> {
		const key = JSON.stringify(path)
		const state = this.scopes.get(key) ?? defaultScopeState()
		if (state.fetching) return

		this.updateScopeState(path, { fetching: true })

		try {
			const historyResult = await this.server.history(path, state.confirmedClock)
			const dataResult = await this.server.list(path, {})

			const history = this.getScopeHistory(path)
			for (const commit of historyResult.commits) {
				const wasPending = this.pendingCommits.some((p) => p.id === commit.id)
				const confirmed: ConfirmedCommit<R> = { ...(commit as Commit<R>), isLocal: wasPending }
				history.write({ set: [{ key: commit.clock, value: confirmed }] })
				if (wasPending) {
					this.removePendingCommit(commit.id)
				}
			}

			const dataPrefix = [...path, "data"]
			const existingData = this.data.list({
				gte: dataPrefix,
				lte: [...dataPrefix, []],
			})
			this.data.write({ delete: existingData.map(({ key }) => key) })
			this.data.write({
				set: dataResult.data.map(({ key, value }) => ({
					key: [...path, ...key],
					value,
				})),
			})

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

			this.updateScopeState(path, {
				confirmedClock: Math.max(state.confirmedClock, historyResult.clock, dataResult.clock),
				fetching: false,
			})
		} catch (error) {
			this.updateScopeState(path, {
				fetching: false,
				lastError: error instanceof Error ? error : new Error(String(error)),
			})
			throw error
		}
	}

	subscribe(range: { gte?: Tuple; lte?: Tuple; gt?: Tuple; lt?: Tuple }, fn: () => void): () => void {
		return this.cache.subscribe(range, fn)
	}

	onStateChange(fn: () => void): () => void {
		this.stateListeners.add(fn)
		return () => this.stateListeners.delete(fn)
	}

	onScopeStateChange(path: Tuple, fn: () => void): () => void {
		const key = JSON.stringify(path)
		let listeners = this.scopeListeners.get(key)
		if (!listeners) {
			listeners = new Set()
			this.scopeListeners.set(key, listeners)
		}
		listeners.add(fn)
		return () => listeners!.delete(fn)
	}

	dispose(): void {
		if (this.unsubscribePubsub) {
			this.unsubscribePubsub()
		}
		for (const key of this.subscribedScopes) {
			this.pubsub.unsubscribe(key)
		}
		this.stateListeners.clear()
		this.scopeListeners.clear()
	}

	// Internal methods used by SyncDbClient

	_getCache(): OkvCache<Tuple, JSONValue> {
		return this.cache
	}

	_getOptimisticTx(): Transaction<Tuple, JSONValue> {
		return this.optimisticTx
	}

	_getScopeHistory(path: Tuple): InMemoryOkv<number, ConfirmedCommit<R>> {
		return this.getScopeHistory(path)
	}

	private getScopeHistory(path: Tuple): InMemoryOkv<number, ConfirmedCommit<R>> {
		const key = JSON.stringify(path)
		let history = this.scopeHistory.get(key)
		if (!history) {
			history = new InMemoryOkv<number, ConfirmedCommit<R>>((a, b) => a - b)
			this.scopeHistory.set(key, history)
		}
		return history
	}

	private updateScopeState(path: Tuple, partial: Partial<ScopeState>): void {
		const key = JSON.stringify(path)
		const state = this.scopes.get(key) ?? defaultScopeState()
		this.scopes.set(key, { ...state, ...partial })
		this.notifyScopeStateChange(path)
	}

	private applyCommitOptimistically(commit: PendingCommit<R>): void {
		const meta: CommitMeta = {
			id: commit.id,
			authorId: commit.authorId,
			createdAt: commit.createdAt,
		}
		const db = this.createTupleDb(this.optimisticTx)
		for (const op of commit.ops) {
			const reducer = this.reducers[op.fn as keyof R]
			if (!reducer) {
				console.warn(`Unknown operation: ${String(op.fn)}`)
				continue
			}
			reducer(db, meta, ...op.args)
		}
	}

	private applyCommitToConfirmedData(commit: PendingCommit<R>): void {
		const meta: CommitMeta = {
			id: commit.id,
			authorId: commit.authorId,
			createdAt: commit.createdAt,
		}
		const db = this.createConfirmedDataTupleDb()
		for (const op of commit.ops) {
			const reducer = this.reducers[op.fn as keyof R]
			if (!reducer) continue
			reducer(db, meta, ...op.args)
		}
	}

	private createConfirmedDataTupleDb(): TupleDb {
		const self = this
		return {
			compare: codec.compare,
			list: this.data.list,
			write: this.data.write,
			get: (key) => this.data.list({ gte: key, lte: key }).at(0)?.value,
			has: (key) => this.data.list({ gte: key, lte: key }).length > 0,
			set: (key, value) => this.data.write({ set: [{ key, value }] }),
			delete: (key) => this.data.write({ delete: [key] }),
			subspace: (prefix) => self.createConfirmedDataSubspace(prefix),
		}
	}

	private createConfirmedDataSubspace(prefix: Tuple): TupleDb {
		const data = this.data
		const createSubspace = this.createConfirmedDataSubspace.bind(this)
		return {
			compare: codec.compare,
			list: (args = {}) => decodeSubspaceResult(data.list(encodeSubspaceArgs(args, prefix)), prefix),
			write: (args) => data.write(encodeSubspaceWrite(args, prefix)),
			get: (key) => data.list({ gte: [...prefix, ...key], lte: [...prefix, ...key] }).at(0)?.value,
			has: (key) => data.list({ gte: [...prefix, ...key], lte: [...prefix, ...key] }).length > 0,
			set: (key, value) => data.write({ set: [{ key: [...prefix, ...key], value }] }),
			delete: (key) => data.write({ delete: [[...prefix, ...key]] }),
			subspace: (subPrefix) => createSubspace([...prefix, ...subPrefix]),
		}
	}

	private createTupleDb(tx: Transaction<Tuple, JSONValue>): TupleDb {
		const self = this
		return {
			compare: tx.compare,
			list: tx.list,
			write: tx.write,
			get: (key) => tx.list({ gte: key, lte: key }).at(0)?.value,
			has: (key) => tx.list({ gte: key, lte: key }).length > 0,
			set: (key, value) => tx.write({ set: [{ key, value }] }),
			delete: (key) => tx.write({ delete: [key] }),
			subspace: (prefix) => tupleDb(self.createSubspaceTx(tx, prefix)),
		}
	}

	private createSubspaceTx(
		tx: Transaction<Tuple, JSONValue>,
		prefix: Tuple
	): Transaction<Tuple, JSONValue> {
		return {
			compare: tx.compare,
			list: (args = {}) => decodeSubspaceResult(tx.list(encodeSubspaceArgs(args, prefix)), prefix),
			write: (args) => tx.write(encodeSubspaceWrite(args, prefix)),
		} as Transaction<Tuple, JSONValue>
	}

	private removePendingCommit(id: string): void {
		const index = this.pendingCommits.findIndex((c) => c.id === id)
		if (index !== -1) {
			this.pendingCommits.splice(index, 1)
		}
	}

	private rebuildOptimisticState(): void {
		this.optimisticTx = new Transaction(this.data)
		for (const commit of this.pendingCommits) {
			if (commit.status !== "failed") {
				this.applyCommitOptimistically(commit)
			}
		}
	}

	private async handleClockUpdate(key: string, newClock: number): Promise<void> {
		const state = this.scopes.get(key)
		if (!state) return
		if (newClock <= state.confirmedClock) return

		const path = JSON.parse(key) as Tuple
		await this.syncScope(path)
	}

	private notifyStateChange(): void {
		for (const listener of this.stateListeners) {
			listener()
		}
	}

	private notifyScopeStateChange(path: Tuple): void {
		const key = JSON.stringify(path)
		const listeners = this.scopeListeners.get(key)
		if (listeners) {
			for (const listener of listeners) {
				listener()
			}
		}
		this.notifyStateChange()
	}

	private emitDataChanges(): void {
		this.cache.emit([{}])
	}
}
