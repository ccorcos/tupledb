import { Tuple, TupleDb } from "../tupleDb/types"
import { SyncPubSub } from "./PubSub"

/**
 * Outbox entry format as stored by AppDb
 */
export type OutboxEntry = {
	scopes: { scope: Tuple; clock: number }[]
}

/**
 * Processes outbox entries and publishes to PubSub.
 *
 * This function:
 * 1. Reads all pending outbox entries
 * 2. Publishes clock updates to PubSub for each affected scope
 * 3. Deletes processed entries from the outbox
 *
 * Should be called periodically or after writes to ensure timely notifications.
 *
 * @param db - The root TupleDb
 * @param outboxPrefix - The prefix where outbox entries are stored
 * @param pubsub - The PubSub instance to publish to
 * @returns Number of entries processed
 */
export function processOutbox(db: TupleDb, outboxPrefix: Tuple, pubsub: SyncPubSub): number {
	const outbox = db.subspace(outboxPrefix)
	const entries = outbox.list()

	for (const { key, value } of entries) {
		const entry = value as OutboxEntry
		for (const { scope, clock } of entry.scopes) {
			pubsub.channel(scope).publish(clock)
		}
		outbox.delete(key)
	}

	return entries.length
}

/**
 * Creates a continuous outbox processor that polls at regular intervals.
 *
 * @param db - The root TupleDb
 * @param outboxPrefix - The prefix where outbox entries are stored
 * @param pubsub - The PubSub instance to publish to
 * @param intervalMs - How often to poll the outbox (default: 100ms)
 * @returns A stop function to cancel the polling
 */
export function startOutboxProcessor(
	db: TupleDb,
	outboxPrefix: Tuple,
	pubsub: SyncPubSub,
	intervalMs: number = 100
): () => void {
	const interval = setInterval(() => {
		processOutbox(db, outboxPrefix, pubsub)
	}, intervalMs)

	return () => clearInterval(interval)
}
