import {
	EncodeSubspaceListArgs,
	KeyDecodeCacheListResult,
	KeyDecodeList,
	KeyEncodeRange,
	TupleSubspaceEncoder,
	Encoder,
} from "../../tupleDb/Encoder"
import { Range } from "../../tupleDb/Range"
import { CacheListResult, JSONValue, ListArgs, Tuple } from "../../tupleDb/types"
import { ReducerMap } from "../types"
import { AppDbClient } from "./AppDbClient"
import { ConfirmedCommit, HistoryEntry, PendingCommit } from "./types"

export class SyncDbClient<R extends ReducerMap = ReducerMap> {
	readonly path: Tuple

	private appDb: AppDbClient<R>
	private dataPrefix: Tuple
	private encoder: Encoder<Tuple, Tuple>

	constructor(appDb: AppDbClient<R>, path: Tuple) {
		this.appDb = appDb
		this.path = path
		this.dataPrefix = [...path, "data"]
		this.encoder = TupleSubspaceEncoder(this.dataPrefix)
	}

	clock(): number {
		return this.appDb.getClock(this.path)
	}

	isInitialized(): boolean {
		const result = this.appDb.list({
			gte: [...this.path, "clock"],
			lte: [...this.path, "clock"],
		})
		return result.length > 0
	}

	getPendingCommits(): readonly PendingCommit<R>[] {
		return this.appDb.getPendingCommits()
	}

	list(args?: ListArgs<Tuple>): { key: Tuple; value: JSONValue }[] {
		const fullArgs = EncodeSubspaceListArgs(args ?? {}, this.dataPrefix)
		const result = this.appDb._getOptimisticTx().list(fullArgs)
		return KeyDecodeList(result, this.encoder)
	}

	get(key: Tuple): JSONValue | undefined {
		return this.list({ gte: key, lte: key }).at(0)?.value
	}

	cacheStatus(args?: ListArgs<Tuple>): CacheListResult<Tuple, JSONValue> {
		const fullArgs = EncodeSubspaceListArgs(args ?? {}, this.dataPrefix)
		const result = this.appDb._getCache().list(fullArgs)
		return KeyDecodeCacheListResult(result, this.encoder)
	}

	history(range?: { sinceClock?: number; limit?: number }): HistoryEntry<R>[] {
		const entries: HistoryEntry<R>[] = []
		const historyPrefix = [...this.path, "history"]

		const listArgs: ListArgs<Tuple> =
			range?.sinceClock !== undefined
				? { gt: [...historyPrefix, range.sinceClock], lte: [...historyPrefix, []], limit: range?.limit }
				: { gte: historyPrefix, lte: [...historyPrefix, []], limit: range?.limit }

		const confirmed = this.appDb.list(listArgs)
		for (const { value } of confirmed) {
			entries.push({ type: "confirmed", commit: value as ConfirmedCommit<R> })
		}
		for (const commit of this.appDb.getPendingCommits()) {
			entries.push({ type: "pending", commit })
		}
		return entries
	}

	data(prefix: Tuple = []): SyncDbDataView {
		return syncDbDataView(this, prefix)
	}

	subscribe(range: Range<Tuple>, fn: () => void): () => void {
		const fullRange = KeyEncodeRange(range, this.encoder)
		return this.appDb.subscribe(fullRange, fn)
	}

	async initialize(): Promise<void> {
		return this.appDb.initializeScope(this.path)
	}

	async sync(): Promise<void> {
		return this.appDb.syncScope(this.path)
	}

}

export type SyncDbDataView = {
	list(args?: ListArgs<Tuple>): { key: Tuple; value: JSONValue }[]
	get(key: Tuple): JSONValue | undefined
	subspace(prefix: Tuple): SyncDbDataView
	subscribe(range: Range<Tuple>, fn: () => void): () => void
}

export function syncDbDataView<R extends ReducerMap>(
	parent: SyncDbClient<R>,
	prefix: Tuple
): SyncDbDataView {
	const encoder = TupleSubspaceEncoder(prefix)

	return {
		list: (args) => KeyDecodeList(parent.list(EncodeSubspaceListArgs(args ?? {}, prefix)), encoder),
		get: (key) => parent.list({ gte: [...prefix, ...key], lte: [...prefix, ...key] }).at(0)?.value,
		subspace: (subPrefix) => syncDbDataView(parent, [...prefix, ...subPrefix]),
		subscribe: (range, fn) => parent.subscribe(KeyEncodeRange(range, encoder), fn),
	}
}
