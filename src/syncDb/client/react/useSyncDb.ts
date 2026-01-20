import { useMemo, useEffect, useState, useCallback } from "react"
import { SyncDbClient } from "../SyncDbClient"
import { ReducerMap } from "../../types"
import { Tuple } from "../../../tupleDb/types"
import { useAppDb } from "./SyncDbProvider"

export type UseSyncDbResult<R extends ReducerMap> = {
	syncDb: SyncDbClient<R>
	isInitialized: boolean
	clock: number
}

export function useSyncDb<R extends ReducerMap>(path: Tuple): UseSyncDbResult<R> {
	const appDb = useAppDb<R>()
	const pathKey = JSON.stringify(path)
	const [, forceUpdate] = useState({})

	const syncDb = useMemo(() => {
		return appDb.getSyncDb(path)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [appDb, pathKey])

	const isInitialized = syncDb.isInitialized()
	const clock = syncDb.clock()

	const refresh = useCallback(() => forceUpdate({}), [])

	useEffect(() => {
		return syncDb.subscribe({}, refresh)
	}, [syncDb, refresh])

	useEffect(() => {
		if (!isInitialized) {
			syncDb.initialize().catch((error) => {
				console.error(`Failed to initialize scope ${pathKey}:`, error)
			})
		}
	}, [syncDb, pathKey, isInitialized])

	return {
		syncDb,
		isInitialized,
		clock,
	}
}
