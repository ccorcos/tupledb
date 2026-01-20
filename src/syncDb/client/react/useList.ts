import { useEffect, useMemo, useState } from "react"
import { JSONValue, ListArgs, Tuple } from "../../../tupleDb/types"
import { SyncDbClient, SyncDbClientView } from "../AppDbClient"

export type UseListResult<T = { key: Tuple; value: JSONValue }> = {
	data: T[]
}

export function useList<T = { key: Tuple; value: JSONValue }>(
	source: SyncDbClient | SyncDbClientView,
	args?: ListArgs<Tuple>
): UseListResult<T> {
	const [, forceUpdate] = useState({})
	const argsKey = JSON.stringify(args ?? {})

	useEffect(() => {
		const range = argsToRange(args)
		return source.subscribe(range, () => forceUpdate({}))
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [source, argsKey])

	const data = useMemo(() => {
		return source.list(args) as T[]
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [source, argsKey, forceUpdate])

	return { data }
}

function argsToRange<K>(args?: ListArgs<K>): { gt?: K; gte?: K; lt?: K; lte?: K } {
	if (!args) return {}
	return { gt: args.gt, gte: args.gte, lt: args.lt, lte: args.lte }
}
