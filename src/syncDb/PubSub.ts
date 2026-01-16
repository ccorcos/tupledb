import { codec } from "../tupleDb/Codec"
import { Tuple } from "../tupleDb/types"

/**
 * A channel represents a pub/sub topic for a specific key.
 * Subscribers receive values published to the channel.
 */
export type PubSubChannel<T> = {
	subscribe: (listener: (value: T) => void) => () => void
	publish: (value: T) => void
}

/**
 * PubSub provides channels keyed by tuples.
 * Each channel is independent - publishing to one doesn't affect others.
 */
export type PubSub<T> = {
	channel: (key: Tuple) => PubSubChannel<T>
}

/** PubSub for sync - publishes clock values */
export type SyncPubSub = PubSub<number>

/**
 * In-memory implementation for testing and single-process use.
 * Uses the codec to convert tuples to string keys internally.
 */
export class InMemoryPubSub<T> implements PubSub<T> {
	private channels = new Map<string, Set<(value: T) => void>>()

	private tupleToKey(tuple: Tuple): string {
		return codec.encode(tuple)
	}

	channel = (key: Tuple): PubSubChannel<T> => {
		const channelKey = this.tupleToKey(key)
		return {
			subscribe: (listener) => {
				if (!this.channels.has(channelKey)) {
					this.channels.set(channelKey, new Set())
				}
				this.channels.get(channelKey)!.add(listener)
				return () => {
					const listeners = this.channels.get(channelKey)
					listeners?.delete(listener)
					if (listeners?.size === 0) this.channels.delete(channelKey)
				}
			},
			publish: (value) => {
				const listeners = this.channels.get(channelKey)
				if (listeners) {
					for (const listener of listeners) listener(value)
				}
			},
		}
	}

	/** For testing: get subscriber count for a channel */
	subscriberCount(key: Tuple): number {
		return this.channels.get(this.tupleToKey(key))?.size ?? 0
	}
}
