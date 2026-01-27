import { useEffect, useMemo, useState } from "react"
import { JSONValue, ListArgs, Tuple } from "../../../tupleDb/types"
import { LocalResult, SyncDbClient, SyncDbClientView } from "../AppDbClient"

export type UseListResult<T = { key: Tuple; value: JSONValue }> = {
	local: LocalResult<T>
	remote: Promise<void>
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

	const result = useMemo(() => {
		return source.list(args)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [source, argsKey, forceUpdate])

	return {
		local: result.local as LocalResult<T>,
		remote: result.remote,
	}
}

function argsToRange<K>(args?: ListArgs<K>): { gt?: K; gte?: K; lt?: K; lte?: K } {
	if (!args) return {}
	return { gt: args.gt, gte: args.gte, lt: args.lt, lte: args.lte }
}
