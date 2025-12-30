import { ListArgs, ReadOnlyTupleDb, Tuple, TupleDb } from "../tupleDb/types"

// ==========================================================================
// Sync Core Types
// ==========================================================================

export type CommitMetadata = {
	id: string
	authorId?: string // Used for authorization.
	createdAt: string // ISO string when the client created it
}

export type Reducer = (tx: TupleDb, args: any) => void
export type ReducerMap = Record<string, Reducer>
export type Op = { fn: string; args: any }

export type CommitData = {
	clock: number
	commitedAt: string // ISO string when the server wrote it to the database
	ops: Op[]
}

export type Commit = CommitMetadata & CommitData

export type WriteSyncDb<R extends ReducerMap> = {
	[K in keyof R]: (args: Parameters<R[K]>[1]) => void
}

export type SyncDb<R extends ReducerMap> = {
	clock: () => number
	history: ReadOnlyTupleDb
	data: ReadOnlyTupleDb
	write: (commit: (Partial<CommitMetadata> & { ops: Op[] }) | Commit) => Commit
} & WriteSyncDb<R>

// ==========================================================================
// Sync Transport / Server Types
// ==========================================================================

// Explicit Sync Server API Responses

// write() response
export type WriteResult = {
	clock: number
}

// fetch() response (updates only)
export type FetchResult = {
	clock: number
	updates: Commit[]
}

// sync() response (write + fetch)
export type SyncResult = FetchResult

// read() response (fetch + data snapshot)
export type ReadResult = FetchResult & {
	data: { key: Tuple; value: any }[]
}

export type SyncTransport = {
	write: (prefix: any[], commits: Commit[]) => Promise<WriteResult>
	sync: (prefix: any[], commits: Commit[], syncedClock: number) => Promise<SyncResult>
	read: (prefix: any[], range: ListArgs<Tuple>, syncedClock: number) => Promise<ReadResult>
}

export type SyncManagerConfig = {
	db: TupleDb
	reducers: ReducerMap
	transport: SyncTransport
}

export type SyncServer = {
	write(scope: Tuple, commits: Commit[]): WriteResult
	fetch(scope: Tuple, sinceClock: number): FetchResult
	sync(scope: Tuple, commits: Commit[], syncedClock: number): SyncResult
	read(scope: Tuple, range: ListArgs<Tuple>, syncedClock: number): ReadResult
}
