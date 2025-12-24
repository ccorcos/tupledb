import { SyncHistoryEntry } from "../SyncDb"
import { Tuple } from "../types"

// Explicit Sync Server API Responses

// write() response
export type WriteResult = {
	clock: number
}

// fetch() response (updates only)
export type FetchResult = {
	clock: number
	updates: SyncHistoryEntry[]
}

// sync() response (write + fetch)
export type SyncResult = FetchResult

// read() response (fetch + data snapshot)
export type ReadResult = FetchResult & {
	data: { key: Tuple; value: any }[]
}
