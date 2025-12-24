import { TupleTx } from "../types"
import { SyncHistoryEntry } from "../SyncDb"

export type Operation = {
	id: string
	fn: string
	args: any[]
	timestamp: number
}

// Reducers now receive a generic DB interface, which could be a Transaction or a SyncDb wrapper
// We'll keep it as TupleTx for now but it might be augmented
export type Reducer = (tx: TupleTx, ...args: any[]) => void
export type ReducerMap = Record<string, Reducer>

export type SyncPushRequest = {
	ops: Operation[]
	// The last clock the client has confirmed from the server
	syncedClock: number
}

export type SyncPushResponse = {
	// The server's current clock
	serverClock: number
	// History entries that happened since syncedClock
	updates: SyncHistoryEntry[]
}

export type SyncPullResponse = {
	serverClock: number
	updates: SyncHistoryEntry[]
}