import { ListArgs, ReadOnlyTupleDb, Tuple, TupleDb, WriteArgs } from "../tupleDb/types"

export type JSONValue = any

// ==========================================================================
// SyncDb Types
// ==========================================================================

export type Reducer = (tx: TupleDb, ...args: any[]) => void
export type ReducerMap = Record<string, Reducer>

// Helper to extract args parameters (dropping the first 'tx' argument)
type ReducerArgs<F extends Reducer> = F extends (tx: any, ...args: infer A) => any ? A : never

export type Op<R extends ReducerMap = any> = {
	fn: keyof R
	args: ReducerArgs<R[keyof R]>
}

export type OpsBuilder<R extends ReducerMap> = {
	[K in keyof R]: (...args: ReducerArgs<R[K]>) => void
}

export type CommitMeta = {
	id?: string
	authorId?: string
	createdAt?: string
}

export type CommitArgs<R extends ReducerMap = ReducerMap> = CommitMeta & {
	ops: Op<R>[]
}

export type Commit<R extends ReducerMap = ReducerMap> = {
	id: string
	authorId?: string // Used for authorization.
	createdAt: string // ISO string when the client created it
	clock: number
	commitedAt: string // ISO string when the server wrote it to the database
	ops: Op<R>[]
}

export type SyncDb<R extends ReducerMap> = {
	clock: () => number
	history: ReadOnlyTupleDb
	data: ReadOnlyTupleDb
	write: {
		(commit: CommitArgs<R> | Commit<R>): Commit<R>
		(meta: CommitMeta, build: (ops: OpsBuilder<R>) => void): Commit<R>
		(build: (ops: OpsBuilder<R>) => void): Commit<R>
	}
}

// ==========================================================================
// SyncDbClient Types
// ==========================================================================

export interface ISyncClient<GlobalReducers extends ReducerMap> {
	syncDb<R extends ReducerMap>(prefix: Tuple, reducers: R): IClientSyncDb<R>
	write(meta: CommitMeta, build: (ops: OpsBuilder<GlobalReducers>) => void): void
}

export interface IClientSyncDb<R extends ReducerMap> {
	clock: () => number
	data: ReadOnlyTupleDb & {
		subscribe: (
			args: ListArgs<Tuple>,
			listener: (result: { hit?: any[]; miss?: boolean; prefix?: any[] }) => void
		) => SubscribeResult
	}
	history: {
		list: (args?: ListArgs<Tuple>) => { key: Tuple; value: any }[]
	}
    write(meta: CommitMeta, build: (ops: OpsBuilder<R>) => void): void
	// Write is now typically handled via the global client.write,
	// but we might keep a convenience method or remove it.
	// For this refactor, we focus on the global path.
	sync: () => Promise<void>
}

export type PendingCommit<R extends ReducerMap> = {
	commit: Commit<R>
	cleanup: () => void
	changes: WriteArgs<Tuple, JSONValue>
}

export type SubscribeResult = {
	local: { hit?: any[]; miss?: boolean; prefix?: any[] }
	remote: Promise<any[]>
	unsubscribe: () => void
}

// ==========================================================================
// SyncDb API Types
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

export type Pubsub = {
	publish(tuple: Tuple, value: JSONValue): void
	subscribe(tuple: Tuple): void
	onMessage(listener: (tuple: Tuple, value: JSONValue) => void): () => void
}

export type SyncApi = {
	write(scope: Tuple, commits: Commit[]): Promise<WriteResult>
	fetch(scope: Tuple, sinceClock: number): Promise<FetchResult>
	sync(scope: Tuple, commits: Commit[], syncedClock: number): Promise<SyncResult>
	read(scope: Tuple, range: ListArgs<Tuple>, syncedClock: number): Promise<ReadResult>
}
