import { ListArgs, Tuple, JSONValue, WriteArgs } from "../../tupleDb/types"
import { Commit, CommitArgs, Op, ReducerMap } from "../types"

export type PendingCommit<R extends ReducerMap = ReducerMap> = {
	id: string
	authorId?: string
	createdAt: string
	ops: Op<R>[]
	writes: WriteArgs<Tuple, JSONValue>
	localSeq: number
	status: "pending" | "submitting" | "submitted" | "failed"
	error?: string
}

export type ConfirmedCommit<R extends ReducerMap = ReducerMap> = Commit<R> & {
	isLocal: boolean
}

export type HistoryEntry<R extends ReducerMap = ReducerMap> =
	| { type: "pending"; commit: PendingCommit<R> }
	| { type: "confirmed"; commit: ConfirmedCommit<R> }


export type PubsubApi = {
	subscribe(key: string): void
	unsubscribe(key: string): void
	onMessage(listener: (key: string, value: any) => void): () => void
}

export type AppServerApi = {
	list(
		path: Tuple,
		range: ListArgs<Tuple>
	): Promise<{ clock: number; data: { key: Tuple; value: JSONValue }[] }>
	history(
		path: Tuple,
		sinceClock: number
	): Promise<{ clock: number; commits: Commit[] }>
	write(commit: CommitArgs): Promise<void>
}

export type AppDbClientOptions<R extends ReducerMap = ReducerMap> = {
	server: AppServerApi
	pubsub: PubsubApi
	reducers: R
	authorId?: string
}

