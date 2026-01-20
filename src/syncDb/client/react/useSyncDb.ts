import { useMemo, useEffect, useState } from "react"
import { SyncDb } from "../AppDbClient"
import { ReducerMap } from "../../types"
import { Tuple } from "../../../tupleDb/types"
import { useAppDb } from "./SyncDbProvider"

export type UseSyncDbResult<R extends ReducerMap> = {
	syncDb: SyncDb<R>
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

	useEffect(() => () => syncDb.destroy(), [syncDb])
	useEffect(() => syncDb.subscribe({}, () => forceUpdate({})), [syncDb])

	return { syncDb, clock: syncDb.clock() }
}
