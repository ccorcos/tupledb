import { Range } from "../../tupleDb/Range"
import { CacheListResult, JSONValue, ListArgs, Tuple } from "../../tupleDb/types"
import { ReducerMap } from "../types"
import { AppDbClient } from "./AppDbClient"
import { ConfirmedCommit, HistoryEntry, PendingCommit } from "./types"

export class SyncDbClient<R extends ReducerMap = ReducerMap> {
	readonly path: Tuple

	private appDb: AppDbClient<R>
	private dataPrefix: Tuple

	constructor(appDb: AppDbClient<R>, path: Tuple) {
		this.appDb = appDb
		this.path = path
		this.dataPrefix = [...path, "data"]
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
		const fullArgs = this.encodeArgs(args)
		const result = this.appDb._getOptimisticTx().list(fullArgs)
		return this.decodeResult(result)
	}

	get(key: Tuple): JSONValue | undefined {
		return this.list({ gte: key, lte: key }).at(0)?.value
	}

	cacheStatus(args?: ListArgs<Tuple>): CacheListResult<Tuple, JSONValue> {
		const fullArgs = this.encodeArgs(args)
		const result = this.appDb._getCache().list(fullArgs)
		return this.decodeCacheResult(result)
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
		const fullRange = this.encodeRange(range)
		return this.appDb.subscribe(fullRange, fn)
	}

	async initialize(): Promise<void> {
		return this.appDb.initializeScope(this.path)
	}

	async sync(): Promise<void> {
		return this.appDb.syncScope(this.path)
	}

	private encodeArgs(args?: ListArgs<Tuple>): ListArgs<Tuple> {
		if (!args) return { gte: this.dataPrefix, lte: [...this.dataPrefix, []] }
		return {
			...args,
			gt: args.gt ? [...this.dataPrefix, ...args.gt] : undefined,
			gte: args.gte ? [...this.dataPrefix, ...args.gte] : args.gt ? undefined : this.dataPrefix,
			lt: args.lt ? [...this.dataPrefix, ...args.lt] : undefined,
			lte: args.lte
				? [...this.dataPrefix, ...args.lte]
				: args.lt
					? undefined
					: [...this.dataPrefix, []],
		}
	}

	private decodeResult(result: { key: Tuple; value: JSONValue }[]): { key: Tuple; value: JSONValue }[] {
		return result
			.filter(({ key }) => {
				for (let i = 0; i < this.dataPrefix.length; i++) {
					if (key[i] !== this.dataPrefix[i]) return false
				}
				return true
			})
			.map(({ key, value }) => ({
				key: key.slice(this.dataPrefix.length),
				value,
			}))
	}

	private decodeCacheResult(
		result: CacheListResult<Tuple, JSONValue>
	): CacheListResult<Tuple, JSONValue> {
		if (result.miss) return result
		if (result.prefix) {
			return {
				prefix: result.prefix
					.filter(({ key }) => {
						for (let i = 0; i < this.dataPrefix.length; i++) {
							if (key[i] !== this.dataPrefix[i]) return false
						}
						return true
					})
					.map(({ key, value }) => ({
						key: key.slice(this.dataPrefix.length),
						value,
					})),
			}
		}
		if (result.hit) {
			return {
				hit: result.hit
					.filter(({ key }) => {
						for (let i = 0; i < this.dataPrefix.length; i++) {
							if (key[i] !== this.dataPrefix[i]) return false
						}
						return true
					})
					.map(({ key, value }) => ({
						key: key.slice(this.dataPrefix.length),
						value,
					})),
			}
		}
		return result
	}

	private encodeRange(range: Range<Tuple>): Range<Tuple> {
		return {
			gt: range.gt ? [...this.dataPrefix, ...range.gt] : undefined,
			gte: range.gte ? [...this.dataPrefix, ...range.gte] : range.gt ? undefined : this.dataPrefix,
			lt: range.lt ? [...this.dataPrefix, ...range.lt] : undefined,
			lte: range.lte
				? [...this.dataPrefix, ...range.lte]
				: range.lt
					? undefined
					: [...this.dataPrefix, []],
		}
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
	const encodeArgs = (args?: ListArgs<Tuple>): ListArgs<Tuple> => {
		if (!args) return { gte: prefix, lte: [...prefix, []] }
		return {
			...args,
			gt: args.gt ? [...prefix, ...args.gt] : undefined,
			gte: args.gte ? [...prefix, ...args.gte] : args.gt ? undefined : prefix,
			lt: args.lt ? [...prefix, ...args.lt] : undefined,
			lte: args.lte ? [...prefix, ...args.lte] : args.lt ? undefined : [...prefix, []],
		}
	}

	const decodeResult = (result: { key: Tuple; value: JSONValue }[]) => {
		return result
			.filter(({ key }) => {
				for (let i = 0; i < prefix.length; i++) {
					if (key[i] !== prefix[i]) return false
				}
				return true
			})
			.map(({ key, value }) => ({ key: key.slice(prefix.length), value }))
	}

	const encodeRange = (range: Range<Tuple>): Range<Tuple> => ({
		gt: range.gt ? [...prefix, ...range.gt] : undefined,
		gte: range.gte ? [...prefix, ...range.gte] : range.gt ? undefined : prefix,
		lt: range.lt ? [...prefix, ...range.lt] : undefined,
		lte: range.lte ? [...prefix, ...range.lte] : range.lt ? undefined : [...prefix, []],
	})

	return {
		list: (args) => decodeResult(parent.list(encodeArgs(args))),
		get: (key) => decodeResult(parent.list(encodeArgs({ gte: key, lte: key }))).at(0)?.value,
		subspace: (subPrefix) => syncDbDataView(parent, [...prefix, ...subPrefix]),
		subscribe: (range, fn) => parent.subscribe(encodeRange(range), fn),
	}
}
