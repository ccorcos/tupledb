import { Tuple, TupleDb } from "../tupleDb/types"

export type PubsubClientApi = {
	subscribe(key: string): void
	unsubscribe(key: string): void
	onMessage(listener: (key: string, value: any) => void): () => void
}

export type PubsubServerApi = {
	publish(key: string, value: any): void
}

export function pubsubQueue(db: TupleDb) {
	return {
		enqueue(timestamp: string, key: Tuple, value: any) {
			db.set(["_publish", timestamp, key], value)
		},
		dequeue() {
			const items = db.subspace(["_publish"]).list({ limit: 1000 })
			return {
				items: items.map(({ key, value }) => ({ key: key.at(-1) as Tuple, value })),
				clear() {
					db.subspace(["_publish"]).write({ delete: items.map(({ key }) => key) })
				},
			}
		},
	}
}

export function publish(db: TupleDb, pubsub: PubsubServerApi) {
	while (true) {
		const { items, clear } = pubsubQueue(db).dequeue()
		if (items.length === 0) break
		for (const { key, value } of items) pubsub.publish(key as any, value)
		clear()
	}
}
