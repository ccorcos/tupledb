import { TupleTx } from "../types"

export type Operation = {
	id: string
	fn: string
	args: any[]
	timestamp: number
}

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
	// Ops that happened since syncedClock that the client missed (excluding the ones just pushed if successful)
	newOps: Operation[]
}

export type SyncPullResponse = {
	serverClock: number
	ops: Operation[]
}
