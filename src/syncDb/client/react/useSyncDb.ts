import { useSyncExternalStore, useMemo, useEffect } from "react"
import { SyncDbClient } from "../SyncDbClient"
import { ScopeState } from "../types"
import { ReducerMap } from "../../types"
import { Tuple } from "../../../tupleDb/types"
import { useAppDb } from "./SyncDbProvider"

export type UseSyncDbResult<R extends ReducerMap> = {
	syncDb: SyncDbClient<R>
	state: ScopeState
	isInitialized: boolean
	isFetching: boolean
	clock: number
	error?: Error
}

export function useSyncDb<R extends ReducerMap>(path: Tuple): UseSyncDbResult<R> {
	const appDb = useAppDb<R>()
	const pathKey = JSON.stringify(path)

	const syncDb = useMemo(() => {
		return appDb.getSyncDb(path)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [appDb, pathKey])

	const state = useSyncExternalStore(
		(callback) => syncDb.onStateChange(callback),
		() => syncDb.getState(),
		() => syncDb.getState()
	)

	useEffect(() => {
		if (!state.initialized) {
			syncDb.initialize().catch((error) => {
				console.error(`Failed to initialize scope ${pathKey}:`, error)
			})
		}
	}, [syncDb, pathKey, state.initialized])

	return {
		syncDb,
		state,
		isInitialized: state.initialized,
		isFetching: state.fetching,
		clock: state.confirmedClock,
		error: state.lastError,
	}
}
