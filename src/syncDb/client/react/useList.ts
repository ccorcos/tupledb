import { useState, useEffect, useMemo, useRef } from "react"
import { SyncDbClient, SyncDbDataView } from "../SyncDbClient"
import { JSONValue, ListArgs, Tuple } from "../../../tupleDb/types"
import { ReducerMap } from "../../types"

export type UseListResult<T = { key: Tuple; value: JSONValue }> = {
	local: T[]
	remote: Promise<T[]>
	isLoading: boolean
	error?: Error
}

export function useList<R extends ReducerMap, T = { key: Tuple; value: JSONValue }>(
	source: SyncDbClient<R> | SyncDbDataView,
	args?: ListArgs<Tuple>
): UseListResult<T> {
	const [, forceUpdate] = useState({})
	const [isLoading, setIsLoading] = useState(false)
	const [error, setError] = useState<Error | undefined>()
	const argsKey = JSON.stringify(args ?? {})
	const remotePromiseRef = useRef<Promise<T[]> | null>(null)
	const resolveRef = useRef<((value: T[]) => void) | null>(null)

	useEffect(() => {
		const range = argsToRange(args)
		const unsubscribe = source.subscribe(range, () => forceUpdate({}))
		return unsubscribe
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [source, argsKey])

	const local = useMemo(() => {
		return source.list(args) as T[]
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [source, argsKey, forceUpdate])

	useEffect(() => {
		let needsFetch = false
		if (source instanceof SyncDbClient) {
			const status = source.cacheStatus(args)
			needsFetch = status.miss === true
		}

		if (needsFetch && source instanceof SyncDbClient) {
			setIsLoading(true)
			remotePromiseRef.current = new Promise<T[]>((resolve) => {
				resolveRef.current = resolve
			})
			source
				.sync()
				.then(() => {
					const data = source.list(args) as T[]
					resolveRef.current?.(data)
					setIsLoading(false)
					setError(undefined)
				})
				.catch((err) => {
					setError(err)
					setIsLoading(false)
					resolveRef.current?.(local)
				})
		} else {
			remotePromiseRef.current = Promise.resolve(local)
			setIsLoading(false)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [source, argsKey])

	useEffect(() => {
		if (!isLoading && resolveRef.current) {
			resolveRef.current(local)
			resolveRef.current = null
		}
	}, [local, isLoading])

	return {
		local,
		remote: remotePromiseRef.current ?? Promise.resolve(local),
		isLoading,
		error,
	}
}

function argsToRange<K>(args?: ListArgs<K>): { gt?: K; gte?: K; lt?: K; lte?: K } {
	if (!args) return {}
	return { gt: args.gt, gte: args.gte, lt: args.lt, lte: args.lte }
}
