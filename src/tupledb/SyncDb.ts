import { KeyEncodeWrite, TupleSubspaceEncoder } from "./Encoder"
import { JSONValue, ListArgs, Tuple, TupleDb, WriteArgs } from "./types"

export type SyncMetadata = {
	txId?: string
	authorId?: string
	timestamp?: number
}

export type SyncHistoryEntry = {
	metadata: SyncMetadata
	changes: WriteArgs<Tuple, JSONValue>
}

export type SyncDb = {
	clock: () => number
	history: (since?: number, limit?: number) => { clock: number; entry: SyncHistoryEntry }[]

	list: (args?: ListArgs<Tuple>) => { key: Tuple; value: JSONValue }[]
	write: (changes: WriteArgs<Tuple, JSONValue>, metadata?: SyncMetadata) => void

	get: (key: Tuple) => JSONValue | undefined
	set: (key: Tuple, value: JSONValue, metadata?: SyncMetadata) => void
	delete: (key: Tuple, metadata?: SyncMetadata) => void
	subspace: (prefix: Tuple) => SyncDb
}

export function writeSyncDb(
	db: TupleDb,
	changes: WriteArgs<Tuple, JSONValue>,
	metadata: SyncMetadata = {}
) {
	// 1. Get the current clock
	const clock = (db.get(["clock"]) as number) ?? 0

	// 2. Write the operation to the history log
	const entry: SyncHistoryEntry = {
		metadata,
		changes,
	}
	db.set(["history", clock + 1], entry)

	// 3. Increment the clock
	db.set(["clock"], clock + 1)

	// 4. Apply writes to the "data" subspace
	const dataSpace = db.subspace(["data"])
	dataSpace.write(changes)
}

export function syncDb(db: TupleDb): SyncDb {
	const dataSpace = db.subspace(["data"])
	const historySpace = db.subspace(["history"])
	const defaultMetadata = (db as any).syncMetadata || {}

	return {
		clock: () => (db.get(["clock"]) as number) ?? 0,
		history: (since = 0, limit) => {
			// List history after 'since'
			const entries = historySpace.list({ gt: [since], limit })
			return entries.map(({ key, value }) => ({
				clock: key[0] as number,
				entry: value as SyncHistoryEntry,
			}))
		},
		write: (changes, metadata) => {
			writeSyncDb(db, changes, { ...defaultMetadata, ...metadata })
		},
		set: (key, value, metadata) => {
			writeSyncDb(db, { set: [{ key, value }] }, { ...defaultMetadata, ...metadata })
		},
		delete: (key, metadata) => {
			writeSyncDb(db, { delete: [key] }, { ...defaultMetadata, ...metadata })
		},
		get: (key) => dataSpace.get(key),
		list: (args) => dataSpace.list(args),
		subspace: (prefix) => {
			return subspaceSyncDb(db, prefix)
		},
	}
}

function subspaceSyncDb(rootDb: TupleDb, prefix: Tuple): SyncDb {
	const rootData = rootDb.subspace(["data"])
	const subspaceData = rootData.subspace(prefix)
	const encoder = TupleSubspaceEncoder(prefix)

	// Helper to prefix keys
	const prepend = (k: Tuple) => [...prefix, ...k]

	return {
		clock: () => (rootDb.get(["clock"]) as number) ?? 0,
		history: (since, limit) => {
			// Returns GLOBAL history.
			// Ideally we could filter for changes affecting this subspace,
			// but for now we return the root history.
			return syncDb(rootDb).history(since, limit)
		},
		write: (changes, metadata) => {
			// Prefix the keys
			const prefixedChanges = KeyEncodeWrite(changes, encoder)
			writeSyncDb(rootDb, prefixedChanges, metadata)
		},
		set: (key, value, metadata) => {
			writeSyncDb(rootDb, { set: [{ key: prepend(key), value }] }, metadata)
		},
		delete: (key, metadata) => {
			writeSyncDb(rootDb, { delete: [prepend(key)] }, metadata)
		},
		get: (key) => subspaceData.get(key),
		list: (args) => subspaceData.list(args),
		subspace: (nestedPrefix) => subspaceSyncDb(rootDb, [...prefix, ...nestedPrefix]),
	}
}