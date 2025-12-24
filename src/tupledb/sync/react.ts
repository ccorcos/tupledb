import { useSyncExternalStore, useMemo } from "react"
import { SyncManager, SyncSession } from "./SyncClient"
import { ListArgs } from "../types"
import { EncodeSubspaceListArgs, KeyDecodeCacheListResult, TupleSubspaceEncoder } from "../Encoder"

export function useList(session: SyncSession, path: any[], args: ListArgs<any> = {}) {
    // The session manages data at `[...session.prefix, "data"]`.
    // The user asks for `path` relative to that.
    const effectivePrefix = [...session.prefix, "data", ...path]
    
    // Correctly encode arguments for the subspace
    const range = useMemo(() => {
        return EncodeSubspaceListArgs(args, effectivePrefix)
    }, [JSON.stringify(effectivePrefix), JSON.stringify(args)])

    const subscribe = useMemo(() => {
        return (onStoreChange: () => void) => {
            return session.manager.cache.subscribe(range, onStoreChange)
        }
    }, [session, range])

    const getSnapshot = () => {
        const result = session.manager.cache.list(range)
        // Decode the results so the user sees keys relative to their requested path?
        // Wait, if I ask for "inbox", I expect keys like "msg1", not "user/1/data/inbox/msg1".
        // `TupleSubspaceEncoder` with `effectivePrefix` strips that prefix.
        const encoder = TupleSubspaceEncoder(effectivePrefix)
        return KeyDecodeCacheListResult(result, encoder)
    }

    return useSyncExternalStore(subscribe, getSnapshot)
}

export function useSyncDb(manager: SyncManager, prefix: any[]) {
    // Get or create the session for this prefix
    return useMemo(() => {
        return manager.session(prefix)
    }, [manager, JSON.stringify(prefix)])
}
