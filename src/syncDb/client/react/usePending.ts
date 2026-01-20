import { useState, useEffect, useMemo } from "react"
import { AppDbClient } from "../AppDbClient"
import { ReducerMap } from "../../types"
import { useAppDb } from "./SyncDbProvider"

export type UsePendingResult = {
	pendingIds: string[]
	hasPending: boolean
	hasFailed: boolean
}

export function usePending<R extends ReducerMap>(appDb?: AppDbClient<R>): UsePendingResult {
	const contextAppDb = useAppDb<R>()
	const db = appDb ?? contextAppDb

	const [, forceUpdate] = useState({})

	useEffect(() => {
		return db.onStateChange(() => forceUpdate({}))
	}, [db])

	const pending = db.getPendingCommits()
	const pendingIds = useMemo(() => pending.map((c) => c.id), [pending])
	const hasFailed = useMemo(() => pending.some((c) => c.status === "failed"), [pending])

	return {
		pendingIds,
		hasPending: pendingIds.length > 0,
		hasFailed,
	}
}
