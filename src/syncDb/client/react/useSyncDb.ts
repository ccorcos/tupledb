import { useEffect, useMemo, useState } from "react"
import { Tuple } from "../../../tupleDb/types"
import { SyncDbClient } from "../AppDbClient"
import { useAppDb } from "./SyncDbProvider"

export type UseSyncDbResult = {
	syncDb: SyncDbClient
	clock: number
}

export function useSyncDb(path: Tuple): UseSyncDbResult {
	const appDb = useAppDb()
	const pathKey = JSON.stringify(path)
	const [, forceUpdate] = useState({})

	const syncDb = useMemo(() => {
		return appDb.syncDb(path)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [appDb, pathKey])

	useEffect(() => () => syncDb.destroy(), [syncDb])
	useEffect(() => syncDb.subscribe({}, () => forceUpdate({})), [syncDb])

	return { syncDb, clock: syncDb.clock() }
}
