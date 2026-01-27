import { OkvCache } from "./OkvCache"
import { CacheListResult, ListArgs, WriteArgs } from "./types"

export type OptimisticListResult<K, V> = {
	hit?: { key: K; value: V }[]
	miss?: { key: K; value: V }[]
	prefix?: { key: K; value: V }[]
}

export function optimisticList<K, V>(
	cache: OkvCache<K, V>,
	pendingWrites: WriteArgs<K, V>[],
	compare: (a: K, b: K) => number,
	args?: ListArgs<K>
): OptimisticListResult<K, V> {
	const cacheResult = cache.list(args ?? {})
	return mergeWithPending(cacheResult, pendingWrites, compare, args)
}

function mergeWithPending<K, V>(
	cacheResult: CacheListResult<K, V>,
	pendingWrites: WriteArgs<K, V>[],
	compare: (a: K, b: K) => number,
	args?: ListArgs<K>
): OptimisticListResult<K, V> {
	let data: { key: K; value: V }[]
	if (cacheResult.hit) data = [...cacheResult.hit]
	else if (cacheResult.prefix) data = [...cacheResult.prefix]
	else data = []

	for (const writes of pendingWrites) {
		data = applyWrites(data, writes, compare, args)
	}

	if (cacheResult.hit) return { hit: data }
	if (cacheResult.prefix) return { prefix: data }
	return { miss: data }
}

function applyWrites<K, V>(
	data: { key: K; value: V }[],
	writes: WriteArgs<K, V>,
	compare: (a: K, b: K) => number,
	args?: ListArgs<K>
): { key: K; value: V }[] {
	if (writes.delete) {
		data = data.filter(
			(item) => !writes.delete!.some((k) => compare(item.key, k) === 0)
		)
	}

	if (writes.set) {
		for (const { key, value } of writes.set) {
			if (!keyInRange(key, compare, args)) continue

			const idx = data.findIndex((item) => compare(item.key, key) === 0)
			if (idx !== -1) {
				data[idx] = { key, value }
			} else {
				const insertIdx = data.findIndex(
					(item) => compare(item.key, key) > 0
				)
				if (insertIdx === -1) data.push({ key, value })
				else data.splice(insertIdx, 0, { key, value })
			}
		}
	}

	return data
}

function keyInRange<K>(key: K, compare: (a: K, b: K) => number, args?: ListArgs<K>): boolean {
	if (!args) return true
	if (args.gt && compare(key, args.gt) <= 0) return false
	if (args.gte && compare(key, args.gte) < 0) return false
	if (args.lt && compare(key, args.lt) >= 0) return false
	if (args.lte && compare(key, args.lte) > 0) return false
	return true
}
