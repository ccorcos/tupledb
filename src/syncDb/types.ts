import { TupleDb } from "../tupleDb/types"

export type JSONValue = any

/**
 * A reducer function that handles an operation.
 * Receives the transaction, commit metadata (for authorization), and operation args.
 */
export type Reducer = (tx: TupleDb, commit: CommitMeta, ...args: any[]) => void
export type ReducerMap = Record<string, Reducer>

// Helper to extract args parameters (dropping the first 'tx' and 'commit' arguments)
type ReducerArgs<F extends Reducer> = F extends (tx: any, commit: any, ...args: infer A) => any
	? A
	: never

export type Op<R extends ReducerMap = ReducerMap> = {
	[K in keyof R]: {
		fn: K
		args: ReducerArgs<R[K]>
	}
}[keyof R]

/**
 * Input for creating a commit (what the client provides).
 */
export type CommitArgs<R extends ReducerMap = ReducerMap> = {
	id?: string
	authorId?: string
	createdAt?: string
	ops: Op<R>[]
}

/**
 * Metadata passed to reducers when a commit is applied.
 * The id is always present because the server assigns one if not provided.
 */
export type CommitMeta = {
	id: string
	authorId?: string
	createdAt?: string
	commitedAt?: string // Written on the server but not the client.
}

/**
 * A fully-formed commit as stored in history (what the server produces).
 * Includes server-assigned clock.
 */
export type Commit<R extends ReducerMap = ReducerMap> = CommitMeta & {
	clock: number
	ops: Op<R>[]
}
