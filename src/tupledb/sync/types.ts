import { SyncHistoryEntry } from "../SyncDb"

export type SyncPushRequest = {
	ops: SyncHistoryEntry[] // We send the semantic ops (metadata + op)
	syncedClock: number
}

export type SyncPushResponse = {
	serverClock: number
	updates: SyncHistoryEntry[]
}

export type SyncPullResponse = {
	serverClock: number
	updates: SyncHistoryEntry[]
}
