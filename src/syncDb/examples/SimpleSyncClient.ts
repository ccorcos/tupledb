import { codec } from "../../tupleDb/Codec"
import { OkvCache, cachedRange } from "../../tupleDb/OkvCache"
import { TupleCache } from "../../tupleDb/TupleCache"
import { ListArgs, Tuple, TupleDb, WriteArgs } from "../../tupleDb/types"
import { Commit, SyncApi } from "../types"

export type QueryResult<T = any> = {
	loading: boolean
	data: { key: Tuple; value: T }[]
}

export type QueryCallback<T = any> = (result: QueryResult<T>) => void

export class SimpleSyncClient {
	public cache: TupleCache
	private reducers: any

	constructor(
		public api: SyncApi,
		reducers: any
	) {
		this.cache = new TupleCache(new OkvCache(codec.compare))
		this.reducers = reducers
	}

	sync(scope: Tuple) {
		return new ScopedSync(this, scope, this.reducers)
	}
}

class ScopedSync {
	private fullPrefix: Tuple

	constructor(
		private client: SimpleSyncClient,
		private scope: Tuple,
		private reducers: any
	) {
		this.fullPrefix = [...scope, "data"]
	}

	query<T = any>(args: ListArgs<Tuple>, callback: QueryCallback<T>): () => void {
		// 1. Translate user args to absolute cache args
		const absoluteRange = this.toAbsoluteRange(args)

		// 2. Subscribe to Cache
		// We use a cachedRange that strips the prefix for the user's view
		const unsubscribeCache = this.client.cache.subscribe(
			cachedRange(absoluteRange, []), // The filter inside cachedRange handles the 'hit' logic
			() => {
				const res = this.client.cache.list(absoluteRange)
				callback({
					loading: false, // Cache update means we have data (or are consistent with local ops)
					data: this.stripPrefix(res.hit || []),
				})
			}
		)

		// 3. Initial Callback from Cache
		const initialRes = this.client.cache.list(absoluteRange)
		callback({
			loading: true, // Still loading from network
			data: this.stripPrefix(initialRes.hit || []),
		})

		// 4. Trigger Network Fetch
		this.refresh(args)

		return () => {
			unsubscribeCache()
		}
	}

	async write(ops: any[]) {
		const commit: Commit = {
			id: Math.random().toString(36).slice(2),
			clock: 0,
			commitedAt: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			ops,
		}

		// 1. Optimistic Update
		const writes: WriteArgs<Tuple, any> = { set: [], delete: [] }
		const tx = this.createProxyTx(writes)

		for (const op of ops) {
			const fn = this.reducers[op.fn]
			if (fn) fn(tx, ...op.args)
		}
		this.client.cache.write(writes)

		// 2. Send to Server
		try {
			await this.client.api.write(this.scope, [commit])
			// Success? Maybe trigger a fetch to confirm/get official clock?
			// Ideally we would replace our optimistic clock/state with the confirmed one.
			// For this example, we trust the optimistic update matches the server's eventual state.
		} catch (e) {
			console.error("Write failed", e)
			// Revert?
		}
	}

	// Fetch data from server and merge into cache
	async refresh(range: ListArgs<Tuple>) {
		// Get current clock for this scope
		const clockKey = [...this.scope, "clock"]
		const clockRes = this.client.cache.list({ gte: clockKey, lte: clockKey })
		const currentClock = (clockRes.hit?.[0]?.value as number) || 0

		try {
			// We use `read` to get a snapshot + updates.
			const res = await this.client.api.read(this.scope, range, currentClock)

			const fullPrefix = [...this.scope, "data"]
			const absoluteData = res.data.map((item) => ({
				key: [...fullPrefix, ...item.key],
				value: item.value,
			}))

			// We need to mark the *Range* as cached, not just the keys.
			// TupleCache wraps OkvCache, and we need to use OkvCache.insert logic
			// which is designed exactly for this "I fetched a range, here is the result" pattern.
			// Since we instantiated it with OkvCache, we can cast/access it.
			const okvCache = this.client.cache.cache as OkvCache<Tuple, any>

			// We need the absolute range to tell the cache what we covered.
			const absRange = this.toAbsoluteRange(range)

			if (okvCache.insert) {
				okvCache.insert([
					{
						args: absRange,
						result: absoluteData,
					},
				])
			} else {
				// Fallback if interface doesn't match (shouldn't happen with concrete OkvCache)
				const writes: WriteArgs<Tuple, any> = { set: [], delete: [] }
				for (const item of absoluteData) {
					writes.set!.push(item)
				}
				this.client.cache.write(writes)
			}

			// Apply Clock Update
			this.client.cache.write({ set: [{ key: clockKey, value: res.clock }] })
		} catch (e) {
			console.error("Refresh failed", e)
		}
	}

	private toAbsoluteRange(range: ListArgs<Tuple>): ListArgs<Tuple> {
		const abs: ListArgs<Tuple> = {}
		const fullPrefix = this.fullPrefix

		// Handle explicit bounds
		if (range.gte) abs.gte = [...fullPrefix, ...range.gte]
		if (range.gt) abs.gt = [...fullPrefix, ...range.gt]
		if (range.lte) abs.lte = [...fullPrefix, ...range.lte]
		if (range.lt) abs.lt = [...fullPrefix, ...range.lt]

		// Handle prefix by converting to gte/lte
		if (range.prefix) {
			const p = [...fullPrefix, ...range.prefix]
			// Intersect with existing bounds or set them
			// For simplicity in this example, we assume prefix is the primary constraint
			// or that the user wouldn't provide conflicting bounds.
			// Ideally we would max(gte, p) and min(lte, p + null).
			if (!abs.gte) abs.gte = p
			// Append null as MAX sentinel for the prefix
			if (!abs.lte) abs.lte = [...p, null]
		} else if (!range.gte && !range.gt && !range.lte && !range.lt) {
			// If no bounds at all, we are querying the whole scope?
			// The scope itself is a prefix of the global DB.
			// So we should bound it by the scope.
			if (!abs.gte) abs.gte = fullPrefix
			if (!abs.lte) abs.lte = [...fullPrefix, null]
		}

		// Remove prefix from the result passed to cache, so it uses the explicit bounds
		const { prefix, ...rest } = range
		return { ...rest, ...abs }
	}

	private stripPrefix(items: { key: Tuple; value: any }[]) {
		const prefixLen = this.fullPrefix.length
		return items.map((item) => ({
			key: item.key.slice(prefixLen),
			value: item.value,
		}))
	}

	private createProxyTx(writes: WriteArgs<Tuple, any>): TupleDb {
		const fullPrefix = this.fullPrefix
		return {
			set: (key, value) => {
				writes.set!.push({ key: [...fullPrefix, ...key], value })
			},
			delete: (key) => {
				writes.delete!.push([...fullPrefix, ...key])
			},
			get: (key) => {
				const res = this.client.cache.list({ prefix: [...fullPrefix, ...key] })
				return res.hit?.[0]?.value
			},
		} as any
	}
}