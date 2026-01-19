import { Tuple, TupleDb } from "../../tupleDb/types"
import { applySyncCommit } from "../SyncNode"
import { CommitMeta, ReducerMap } from "../types"

// =============================================================================
// Types
// =============================================================================

export type User = {
	type: "user"
	id: string
	name: string
}

export type Message = {
	type: "message"
	id: string
	from: string
	to: string[]
	datetime: string
	body: string
}

// =============================================================================
// Scope Reducers: User (at ["users", userId])
// =============================================================================

export const messagingUserReducers: ReducerMap = {
	setProfile: (tx: TupleDb, _commit: CommitMeta, user: User) => {
		tx.set(["profile"], user)
	},

	sendMessage: (tx: TupleDb, _commit: CommitMeta, msg: Message) => {
		// Store the full message
		tx.set(["message", msg.id], msg)
		// Index in outbox (by datetime for chronological order)
		tx.set(["outbox", msg.datetime, msg.id], null)
	},

	receiveMessage: (tx: TupleDb, _commit: CommitMeta, msg: Message) => {
		// Store the full message
		tx.set(["message", msg.id], msg)
		// Index in inbox (by datetime for chronological order)
		tx.set(["inbox", msg.datetime, msg.id], null)
	},

	deleteMessage: (tx: TupleDb, _commit: CommitMeta, msgId: string) => {
		const msg = tx.get(["message", msgId]) as Message | undefined
		if (!msg) return

		tx.delete(["message", msgId])
		// Remove from both indexes (only one will exist, but safe to try both)
		tx.delete(["outbox", msg.datetime, msgId])
		tx.delete(["inbox", msg.datetime, msgId])
	},

	markRead: (tx: TupleDb, _commit: CommitMeta, msgId: string) => {
		const msg = tx.get(["message", msgId]) as Message | undefined
		if (!msg) return

		// Remove from unread index if exists
		tx.delete(["unread", msg.datetime, msgId])
	},

	addUnread: (tx: TupleDb, _commit: CommitMeta, msg: Message) => {
		tx.set(["unread", msg.datetime, msg.id], null)
	},
}

// =============================================================================
// App Reducers
// =============================================================================

export const messagingAppReducers = {
	/**
	 * Set a user or message.
	 * For messages, this fans out to sender's outbox and recipients' inboxes.
	 */
	set: (tx: TupleDb, commit: CommitMeta, value: User | Message) => {
		if (value.type === "user") {
			const user = value
			const scope: Tuple = ["users", user.id]

			applySyncCommit(tx, scope, messagingUserReducers, {
				...commit,
				ops: [{ fn: "setProfile", args: [user] }],
			})
		} else if (value.type === "message") {
			const msg = value

			// Add to sender's outbox
			const senderScope: Tuple = ["users", msg.from]
			applySyncCommit(tx, senderScope, messagingUserReducers, {
				...commit,
				ops: [{ fn: "sendMessage", args: [msg] }],
			})

			// Add to each recipient's inbox
			for (const userId of msg.to) {
				const recipientScope: Tuple = ["users", userId]
				applySyncCommit(tx, recipientScope, messagingUserReducers, {
					...commit,
					ops: [
						{ fn: "receiveMessage", args: [msg] },
						{ fn: "addUnread", args: [msg] },
					],
				})
			}
		} else {
			throw new Error(`Unknown type: ${(value as any).type}`)
		}
	},

	/**
	 * Delete a user or message.
	 * For messages, only deletes from the requesting user's scope (not all recipients).
	 */
	delete: (
		tx: TupleDb,
		commit: CommitMeta,
		args: { type: string; id: string; userId: string }
	) => {
		const { type, id, userId } = args

		if (type === "user") {
			// Deleting a user would require more complex cleanup
			// For now, just mark as deleted
			const scope: Tuple = ["users", id]
			applySyncCommit(tx, scope, messagingUserReducers, {
				...commit,
				ops: [{ fn: "setProfile", args: [null] }],
			})
		} else if (type === "message") {
			// Delete from the requesting user's scope only
			const scope: Tuple = ["users", userId]
			applySyncCommit(tx, scope, messagingUserReducers, {
				...commit,
				ops: [{ fn: "deleteMessage", args: [id] }],
			})
		} else {
			throw new Error(`Unknown type: ${type}`)
		}
	},

	/**
	 * Mark a message as read for a specific user.
	 */
	markRead: (tx: TupleDb, commit: CommitMeta, args: { messageId: string; userId: string }) => {
		const { messageId, userId } = args
		const scope: Tuple = ["users", userId]

		applySyncCommit(tx, scope, messagingUserReducers, {
			...commit,
			ops: [{ fn: "markRead", args: [messageId] }],
		})
	},

	/**
	 * Send a direct message (convenience wrapper around set).
	 */
	sendMessage: (
		tx: TupleDb,
		commit: CommitMeta,
		args: { from: string; to: string[]; body: string; id?: string }
	) => {
		const msg: Message = {
			type: "message",
			id: args.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			from: args.from,
			to: args.to,
			datetime: new Date().toISOString(),
			body: args.body,
		}

		messagingAppReducers.set(tx, commit, msg)
	},

	/**
	 * Create a user profile.
	 */
	createUser: (tx: TupleDb, commit: CommitMeta, args: { id: string; name: string }) => {
		const user: User = {
			type: "user",
			id: args.id,
			name: args.name,
		}

		messagingAppReducers.set(tx, commit, user)
	},
} satisfies ReducerMap

// Type for app reducers
export type MessagingAppReducers = typeof messagingAppReducers
