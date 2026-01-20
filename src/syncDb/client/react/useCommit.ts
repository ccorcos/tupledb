import { useState, useCallback } from "react"
import { AppDbClient } from "../AppDbClient"
import { Op, ReducerMap } from "../../types"
import { useAppDb } from "./SyncDbProvider"

export type UseCommitResult<R extends ReducerMap> = {
	commit: (ops: Op<R>[]) => Promise<void>
	isSubmitting: boolean
	error?: Error
	clearError: () => void
	retry: (commitId: string) => Promise<void>
	cancel: (commitId: string) => void
}

export function useCommit<R extends ReducerMap>(appDb?: AppDbClient<R>): UseCommitResult<R> {
	const contextAppDb = useAppDb<R>()
	const db = appDb ?? contextAppDb

	const [isSubmitting, setIsSubmitting] = useState(false)
	const [error, setError] = useState<Error | undefined>()

	const commit = useCallback(
		async (ops: Op<R>[]): Promise<void> => {
			setIsSubmitting(true)
			setError(undefined)
			try {
				await db.commit(ops)
			} catch (e) {
				const err = e instanceof Error ? e : new Error(String(e))
				setError(err)
				throw err
			} finally {
				setIsSubmitting(false)
			}
		},
		[db]
	)

	const clearError = useCallback(() => setError(undefined), [])

	const retry = useCallback(
		async (commitId: string): Promise<void> => {
			setIsSubmitting(true)
			setError(undefined)
			try {
				await db.retryCommit(commitId)
			} catch (e) {
				const err = e instanceof Error ? e : new Error(String(e))
				setError(err)
				throw err
			} finally {
				setIsSubmitting(false)
			}
		},
		[db]
	)

	const cancel = useCallback(
		(commitId: string): void => {
			db.cancelCommit(commitId)
		},
		[db]
	)

	return { commit, isSubmitting, error, clearError, retry, cancel }
}
