import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { InMemoryPubSub } from "./PubSub"

describe("InMemoryPubSub", () => {
	it("publishes to subscribers", () => {
		const pubsub = new InMemoryPubSub<number>()
		const received: number[] = []

		const unsub = pubsub.channel(["room", "1"]).subscribe((v) => received.push(v))

		pubsub.channel(["room", "1"]).publish(1)
		pubsub.channel(["room", "1"]).publish(2)

		assert.deepEqual(received, [1, 2])

		unsub()
		pubsub.channel(["room", "1"]).publish(3)
		assert.deepEqual(received, [1, 2]) // No new values after unsub
	})

	it("isolates channels by key", () => {
		const pubsub = new InMemoryPubSub<number>()
		const room1: number[] = []
		const room2: number[] = []

		pubsub.channel(["room", "1"]).subscribe((v) => room1.push(v))
		pubsub.channel(["room", "2"]).subscribe((v) => room2.push(v))

		pubsub.channel(["room", "1"]).publish(1)
		pubsub.channel(["room", "2"]).publish(2)

		assert.deepEqual(room1, [1])
		assert.deepEqual(room2, [2])
	})

	it("cleans up empty channels", () => {
		const pubsub = new InMemoryPubSub<number>()

		const unsub = pubsub.channel(["room", "1"]).subscribe(() => {})
		assert.equal(pubsub.subscriberCount(["room", "1"]), 1)

		unsub()
		assert.equal(pubsub.subscriberCount(["room", "1"]), 0)
	})

	it("supports multiple subscribers on same channel", () => {
		const pubsub = new InMemoryPubSub<number>()
		const received1: number[] = []
		const received2: number[] = []

		const unsub1 = pubsub.channel(["room", "1"]).subscribe((v) => received1.push(v))
		const unsub2 = pubsub.channel(["room", "1"]).subscribe((v) => received2.push(v))

		pubsub.channel(["room", "1"]).publish(42)

		assert.deepEqual(received1, [42])
		assert.deepEqual(received2, [42])

		unsub1()
		pubsub.channel(["room", "1"]).publish(43)

		assert.deepEqual(received1, [42]) // unsub1 stopped receiving
		assert.deepEqual(received2, [42, 43]) // unsub2 still receiving

		unsub2()
	})

	it("handles complex tuple keys", () => {
		const pubsub = new InMemoryPubSub<string>()
		const received: string[] = []

		pubsub.channel(["users", 123, "posts", "abc"]).subscribe((v) => received.push(v))

		pubsub.channel(["users", 123, "posts", "abc"]).publish("hello")
		pubsub.channel(["users", 123, "posts", "def"]).publish("ignored")
		pubsub.channel(["users", 456, "posts", "abc"]).publish("also ignored")

		assert.deepEqual(received, ["hello"])
	})
})
