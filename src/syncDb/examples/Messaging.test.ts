import { PubsubHarness } from "fixtures/PubsubHarness"
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { appDb, publish } from "../SyncNode"
import { tupleDb } from "../../tupleDb/TupleDb"
import { Tuple, TupleDb } from "../../tupleDb/types"
import { Message, messagingAppReducers } from "./Messaging"

function server() {
	const db = tupleDb()
	const pubsub = new PubsubHarness()
	const app = appDb(db, messagingAppReducers)
	const api = {
		list: app.list,
		write(args: Parameters<typeof app.write>[0]) {
			app.write(args)
			publish(db, pubsub)
		},
	}
	return { db, api }
}

function getServerData(db: TupleDb, scope: Tuple): { key: Tuple; value: any }[] {
	return db.subspace([...scope, "data"]).list()
}

describe("Messaging App", () => {
	describe("Server-side operations", () => {
		it("creates a user profile", () => {
			const { db, api } = server()

			api.write({
				ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice Smith" }] }],
			})

			const userData = getServerData(db, ["users", "alice"])
			const profile = userData.find((d) => d.key[0] === "profile")
			assert.ok(profile)
			assert.deepEqual(profile.value, { type: "user", id: "alice", name: "Alice Smith" })
		})

		it("sends a message - appears in sender outbox and recipient inbox", () => {
			const { db, api } = server()

			// Create users
			api.write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			api.write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })

			// Send message
			const msg: Message = {
				type: "message",
				id: "msg1",
				from: "alice",
				to: ["bob"],
				datetime: "2024-01-15T10:00:00Z",
				body: "Hello Bob!",
			}

			api.write({ ops: [{ fn: "set", args: [msg] }] })

			// Check alice's outbox
			const aliceData = getServerData(db, ["users", "alice"])
			const aliceOutbox = aliceData.filter((d) => d.key[0] === "outbox")
			assert.equal(aliceOutbox.length, 1)
			assert.equal(aliceOutbox[0].key[2], "msg1")

			// Check alice has message stored
			const aliceMsg = aliceData.find((d) => d.key[0] === "message" && d.key[1] === "msg1")
			assert.ok(aliceMsg)
			assert.equal(aliceMsg.value.body, "Hello Bob!")

			// Check bob's inbox
			const bobData = getServerData(db, ["users", "bob"])
			const bobInbox = bobData.filter((d) => d.key[0] === "inbox")
			assert.equal(bobInbox.length, 1)
			assert.equal(bobInbox[0].key[2], "msg1")

			// Check bob has message stored
			const bobMsg = bobData.find((d) => d.key[0] === "message" && d.key[1] === "msg1")
			assert.ok(bobMsg)
			assert.equal(bobMsg.value.body, "Hello Bob!")

			// Check bob has unread marker
			const bobUnread = bobData.filter((d) => d.key[0] === "unread")
			assert.equal(bobUnread.length, 1)
		})

		it("sends message to multiple recipients", () => {
			const { db, api } = server()

			// Create users
			api.write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			api.write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })
			api.write({ ops: [{ fn: "createUser", args: [{ id: "charlie", name: "Charlie" }] }] })

			// Send message to bob and charlie
			api.write({
				ops: [
					{
						fn: "sendMessage",
						args: [{ id: "msg1", from: "alice", to: ["bob", "charlie"], body: "Hello everyone!" }],
					},
				],
			})

			// Verify all three users have the message
			for (const userId of ["alice", "bob", "charlie"]) {
				const userData = getServerData(db, ["users", userId])
				const msg = userData.find((d) => d.key[0] === "message" && d.key[1] === "msg1")
				assert.ok(msg, `${userId} should have the message`)
			}

			// alice has outbox entry
			const aliceData = getServerData(db, ["users", "alice"])
			assert.equal(aliceData.filter((d) => d.key[0] === "outbox").length, 1)
			assert.equal(aliceData.filter((d) => d.key[0] === "inbox").length, 0)

			// bob and charlie have inbox entries
			for (const userId of ["bob", "charlie"]) {
				const userData = getServerData(db, ["users", userId])
				assert.equal(
					userData.filter((d) => d.key[0] === "inbox").length,
					1,
					`${userId} should have inbox entry`
				)
				assert.equal(
					userData.filter((d) => d.key[0] === "outbox").length,
					0,
					`${userId} should not have outbox entry`
				)
			}
		})

		it("marks message as read", () => {
			const { db, api } = server()

			// Setup
			api.write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			api.write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })
			api.write({
				ops: [
					{
						fn: "sendMessage",
						args: [{ id: "msg1", from: "alice", to: ["bob"], body: "Hello!" }],
					},
				],
			})

			// Bob has unread
			let bobData = getServerData(db, ["users", "bob"])
			assert.equal(bobData.filter((d) => d.key[0] === "unread").length, 1)

			// Mark as read
			api.write({
				ops: [{ fn: "markRead", args: [{ messageId: "msg1", userId: "bob" }] }],
			})

			// Bob no longer has unread
			bobData = getServerData(db, ["users", "bob"])
			assert.equal(bobData.filter((d) => d.key[0] === "unread").length, 0)

			// Message still exists
			const msg = bobData.find((d) => d.key[0] === "message" && d.key[1] === "msg1")
			assert.ok(msg)
		})

		it("deletes message from user scope only", () => {
			const { db, api } = server()

			// Setup
			api.write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			api.write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })
			api.write({
				ops: [
					{
						fn: "sendMessage",
						args: [{ id: "msg1", from: "alice", to: ["bob"], body: "Hello!" }],
					},
				],
			})

			// Both have message
			assert.ok(
				getServerData(db, ["users", "alice"]).find(
					(d) => d.key[0] === "message" && d.key[1] === "msg1"
				)
			)
			assert.ok(
				getServerData(db, ["users", "bob"]).find(
					(d) => d.key[0] === "message" && d.key[1] === "msg1"
				)
			)

			// Bob deletes message
			api.write({
				ops: [{ fn: "delete", args: [{ type: "message", id: "msg1", userId: "bob" }] }],
			})

			// Alice still has message
			assert.ok(
				getServerData(db, ["users", "alice"]).find(
					(d) => d.key[0] === "message" && d.key[1] === "msg1"
				)
			)

			// Bob no longer has message
			assert.ok(
				!getServerData(db, ["users", "bob"]).find(
					(d) => d.key[0] === "message" && d.key[1] === "msg1"
				)
			)
			assert.ok(
				!getServerData(db, ["users", "bob"]).find(
					(d) => d.key[0] === "inbox" && d.key[2] === "msg1"
				)
			)
		})
	})

	describe("Complex scenarios", () => {
		it("conversation thread with multiple back-and-forth messages", () => {
			const { db, api } = server()

			// Setup users
			api.write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			api.write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })

			// Conversation
			const messages = [
				{ from: "alice", to: ["bob"], body: "Hi Bob!" },
				{ from: "bob", to: ["alice"], body: "Hey Alice!" },
				{ from: "alice", to: ["bob"], body: "How are you?" },
				{ from: "bob", to: ["alice"], body: "Good! You?" },
				{ from: "alice", to: ["bob"], body: "Great!" },
			]

			for (let i = 0; i < messages.length; i++) {
				api.write({
					ops: [
						{
							fn: "sendMessage",
							args: [{ id: `msg${i}`, ...messages[i] }],
						},
					],
				})
			}

			// Verify totals
			const aliceData = getServerData(db, ["users", "alice"])
			const bobData = getServerData(db, ["users", "bob"])

			// Alice sent 3 messages, received 2
			assert.equal(aliceData.filter((d) => d.key[0] === "outbox").length, 3)
			assert.equal(aliceData.filter((d) => d.key[0] === "inbox").length, 2)
			assert.equal(aliceData.filter((d) => d.key[0] === "message").length, 5)

			// Bob sent 2 messages, received 3
			assert.equal(bobData.filter((d) => d.key[0] === "outbox").length, 2)
			assert.equal(bobData.filter((d) => d.key[0] === "inbox").length, 3)
			assert.equal(bobData.filter((d) => d.key[0] === "message").length, 5)
		})

		it("group message to multiple recipients", () => {
			const { db, api } = server()

			// Setup users
			const users = ["alice", "bob", "charlie", "diana"]
			for (const userId of users) {
				api.write({
					ops: [
						{
							fn: "createUser",
							args: [{ id: userId, name: userId.charAt(0).toUpperCase() + userId.slice(1) }],
						},
					],
				})
			}

			// Alice sends group message
			api.write({
				ops: [
					{
						fn: "sendMessage",
						args: [{
							id: "group-msg",
							from: "alice",
							to: ["bob", "charlie", "diana"],
							body: "Group announcement!",
						}],
					},
				],
			})

			// Alice has outbox entry
			const aliceData = getServerData(db, ["users", "alice"])
			assert.equal(aliceData.filter((d) => d.key[0] === "outbox").length, 1)
			assert.equal(aliceData.filter((d) => d.key[0] === "inbox").length, 0)

			// All recipients have inbox entries
			for (const userId of ["bob", "charlie", "diana"]) {
				const userData = getServerData(db, ["users", userId])
				assert.equal(
					userData.filter((d) => d.key[0] === "inbox").length,
					1,
					`${userId} should have 1 inbox entry`
				)
				assert.equal(
					userData.filter((d) => d.key[0] === "unread").length,
					1,
					`${userId} should have 1 unread entry`
				)
			}
		})

		it("idempotent message sending", () => {
			const { db, api } = server()

			// Setup
			api.write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			api.write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })

			// Send same message twice with same id
			const msg = {
				id: "msg1",
				from: "alice",
				to: ["bob"],
				body: "Hello!",
			}

			api.write({ id: "tx-send", ops: [{ fn: "sendMessage", args: [msg] }] })
			api.write({ id: "tx-send", ops: [{ fn: "sendMessage", args: [msg] }] }) // Duplicate

			// Should only have one message
			const bobData = getServerData(db, ["users", "bob"])
			assert.equal(bobData.filter((d) => d.key[0] === "inbox").length, 1)
			assert.equal(bobData.filter((d) => d.key[0] === "message").length, 1)
		})

		it("messages ordered by datetime", () => {
			const { db, api } = server()

			// Setup
			api.write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			api.write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })

			// Send messages with specific datetimes (out of order)
			const messages: Message[] = [
				{
					type: "message",
					id: "msg3",
					from: "alice",
					to: ["bob"],
					datetime: "2024-01-15T12:00:00Z",
					body: "Third",
				},
				{
					type: "message",
					id: "msg1",
					from: "alice",
					to: ["bob"],
					datetime: "2024-01-15T10:00:00Z",
					body: "First",
				},
				{
					type: "message",
					id: "msg2",
					from: "alice",
					to: ["bob"],
					datetime: "2024-01-15T11:00:00Z",
					body: "Second",
				},
			]

			for (let i = 0; i < messages.length; i++) {
				api.write({ ops: [{ fn: "set", args: [messages[i]] }] })
			}

			// Check Bob's inbox is ordered by datetime
			const bobData = getServerData(db, ["users", "bob"])
			const inboxEntries = bobData
				.filter((d) => d.key[0] === "inbox")
				.sort((a, b) => (a.key[1] as string).localeCompare(b.key[1] as string))

			assert.equal(inboxEntries.length, 3)
			assert.equal(inboxEntries[0].key[2], "msg1") // First (earliest datetime)
			assert.equal(inboxEntries[1].key[2], "msg2") // Second
			assert.equal(inboxEntries[2].key[2], "msg3") // Third (latest datetime)
		})
	})
})
