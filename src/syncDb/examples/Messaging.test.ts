import { PubsubHarness } from "fixtures/PubsubHarness"
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { syncServer } from "syncDb/syncServer"
import { tupleDb } from "../../tupleDb/TupleDb"
import { Tuple, TupleDb } from "../../tupleDb/types"
import { Commit } from "../types"
import { Message, User, messagingAppReducers } from "./Messaging"

// ============================================================================
// Test Helpers
// ============================================================================

function createServer() {
	const db = tupleDb()
	const pubsub = new PubsubHarness()
	const server = syncServer(db, pubsub, messagingAppReducers)
	return {
		db,
		write: server.write
	}
}

/** Get data from a sync node's data subspace */
function getData(db: TupleDb, scope: Tuple): { key: Tuple; value: any }[] {
	return db.subspace([...scope, "data"]).list()
}

/** Get history from a sync node */
function getHistory(db: TupleDb, scope: Tuple): Commit[] {
	return db
		.subspace([...scope, "history"])
		.list()
		.map(({ value }) => value as Commit)
}

// ============================================================================
// Builder Helpers - Fluent API for creating test data
// ============================================================================

let idCounter = 0
function nextId(prefix: string = "id"): string {
	return `${prefix}-${++idCounter}`
}

function resetIds() {
	idCounter = 0
}

function createUser(overrides: Partial<User> = {}): User {
	return {
		type: "user",
		id: nextId("user"),
		name: "Test User",
		...overrides,
	}
}

function createMessage(from: string, to: string[], overrides: Partial<Message> = {}): Message {
	return {
		type: "message",
		id: nextId("msg"),
		from,
		to,
		datetime: new Date().toISOString(),
		body: "Test message",
		...overrides,
	}
}

// ============================================================================
// Query Helpers - Clean accessors for test assertions
// ============================================================================

function getProfile(db: TupleDb, userId: string): User | undefined {
	const data = getData(db, ["users", userId])
	const entry = data.find((d) => d.key[0] === "profile")
	return entry?.value as User | undefined
}

function getInbox(db: TupleDb, userId: string): string[] {
	const data = getData(db, ["users", userId])
	return data.filter((d) => d.key[0] === "inbox").map((d) => d.key[2] as string)
}

function getInboxByDatetime(db: TupleDb, userId: string): { datetime: string; msgId: string }[] {
	const data = getData(db, ["users", userId])
	return data
		.filter((d) => d.key[0] === "inbox")
		.map((d) => ({ datetime: d.key[1] as string, msgId: d.key[2] as string }))
		.sort((a, b) => a.datetime.localeCompare(b.datetime))
}

function getOutbox(db: TupleDb, userId: string): string[] {
	const data = getData(db, ["users", userId])
	return data.filter((d) => d.key[0] === "outbox").map((d) => d.key[2] as string)
}

function getMessages(db: TupleDb, userId: string): Message[] {
	const data = getData(db, ["users", userId])
	return data.filter((d) => d.key[0] === "message").map((d) => d.value as Message)
}

function getMessageById(db: TupleDb, userId: string, msgId: string): Message | undefined {
	const data = getData(db, ["users", userId])
	const entry = data.find((d) => d.key[0] === "message" && d.key[1] === msgId)
	return entry?.value as Message | undefined
}

function getUnread(db: TupleDb, userId: string): string[] {
	const data = getData(db, ["users", userId])
	return data.filter((d) => d.key[0] === "unread").map((d) => d.key[2] as string)
}

// ============================================================================
// Tests
// ============================================================================

describe("Messaging App", () => {
	describe("User Operations", () => {
		it("creates a user profile", () => {
			resetIds()
			const { db, write } = createServer()

			write({
				ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice Smith" }] }],
			})

			const profile = getProfile(db, "alice")
			assert.ok(profile)
			assert.equal(profile.id, "alice")
			assert.equal(profile.name, "Alice Smith")
		})

		it("updates a user profile", () => {
			resetIds()
			const { db, write } = createServer()

			write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice Smith" }] }] })

			const profile = getProfile(db, "alice")
			assert.equal(profile?.name, "Alice Smith")
		})
	})

	describe("Message Operations", () => {
		it("sends a message - appears in sender outbox and recipient inbox", () => {
			resetIds()
			const { db, write } = createServer()

			write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })

			const msg = createMessage("alice", ["bob"], {
				id: "msg1",
				body: "Hello Bob!",
				datetime: "2024-01-15T10:00:00Z",
			})
			write({ ops: [{ fn: "set", args: [msg] }] })

			// Sender has message in outbox
			assert.deepEqual(getOutbox(db, "alice"), ["msg1"])
			assert.deepEqual(getInbox(db, "alice"), [])

			// Recipient has message in inbox
			assert.deepEqual(getInbox(db, "bob"), ["msg1"])
			assert.deepEqual(getOutbox(db, "bob"), [])

			// Both have the message stored
			const aliceMsg = getMessageById(db, "alice", "msg1")
			const bobMsg = getMessageById(db, "bob", "msg1")
			assert.equal(aliceMsg?.body, "Hello Bob!")
			assert.equal(bobMsg?.body, "Hello Bob!")

			// Recipient has unread marker
			assert.deepEqual(getUnread(db, "bob"), ["msg1"])
			assert.deepEqual(getUnread(db, "alice"), [])
		})

		it("sends message to multiple recipients", () => {
			resetIds()
			const { db, write } = createServer()

			write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })
			write({ ops: [{ fn: "createUser", args: [{ id: "charlie", name: "Charlie" }] }] })

			write({
				ops: [
					{
						fn: "sendMessage",
						args: [{ id: "msg1", from: "alice", to: ["bob", "charlie"], body: "Hello everyone!" }],
					},
				],
			})

			// All three users have the message
			for (const userId of ["alice", "bob", "charlie"]) {
				assert.ok(getMessageById(db, userId, "msg1"), `${userId} should have the message`)
			}

			// Sender has outbox, recipients have inbox
			assert.equal(getOutbox(db, "alice").length, 1)
			assert.equal(getInbox(db, "alice").length, 0)

			for (const userId of ["bob", "charlie"]) {
				assert.equal(getInbox(db, userId).length, 1, `${userId} should have inbox entry`)
				assert.equal(getOutbox(db, userId).length, 0, `${userId} should not have outbox entry`)
			}
		})

		it("marks message as read", () => {
			resetIds()
			const { db, write } = createServer()

			write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })
			write({
				ops: [{ fn: "sendMessage", args: [{ id: "msg1", from: "alice", to: ["bob"], body: "Hello!" }] }],
			})

			// Bob has unread
			assert.deepEqual(getUnread(db, "bob"), ["msg1"])

			// Mark as read
			write({ ops: [{ fn: "markRead", args: [{ messageId: "msg1", userId: "bob" }] }] })

			// Bob no longer has unread
			assert.deepEqual(getUnread(db, "bob"), [])

			// Message still exists
			assert.ok(getMessageById(db, "bob", "msg1"))
		})

		it("deletes message from user scope only", () => {
			resetIds()
			const { db, write } = createServer()

			write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })
			write({
				ops: [{ fn: "sendMessage", args: [{ id: "msg1", from: "alice", to: ["bob"], body: "Hello!" }] }],
			})

			// Both have message
			assert.ok(getMessageById(db, "alice", "msg1"))
			assert.ok(getMessageById(db, "bob", "msg1"))

			// Bob deletes message
			write({ ops: [{ fn: "delete", args: [{ type: "message", id: "msg1", userId: "bob" }] }] })

			// Alice still has message, Bob doesn't
			assert.ok(getMessageById(db, "alice", "msg1"))
			assert.ok(!getMessageById(db, "bob", "msg1"))
			assert.equal(getInbox(db, "bob").length, 0)
		})
	})

	describe("Message Ordering", () => {
		it("messages ordered by datetime in inbox", () => {
			resetIds()
			const { db, write } = createServer()

			write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })

			// Send messages out of order
			const messages: Message[] = [
				createMessage("alice", ["bob"], { id: "msg3", datetime: "2024-01-15T12:00:00Z", body: "Third" }),
				createMessage("alice", ["bob"], { id: "msg1", datetime: "2024-01-15T10:00:00Z", body: "First" }),
				createMessage("alice", ["bob"], { id: "msg2", datetime: "2024-01-15T11:00:00Z", body: "Second" }),
			]

			for (const msg of messages) {
				write({ ops: [{ fn: "set", args: [msg] }] })
			}

			// Bob's inbox should be ordered by datetime
			const inbox = getInboxByDatetime(db, "bob")
			assert.equal(inbox.length, 3)
			assert.equal(inbox[0].msgId, "msg1") // First (earliest)
			assert.equal(inbox[1].msgId, "msg2") // Second
			assert.equal(inbox[2].msgId, "msg3") // Third (latest)
		})
	})

	describe("Conversations", () => {
		it("conversation thread with multiple back-and-forth messages", () => {
			resetIds()
			const { db, write } = createServer()

			write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })

			// Conversation
			const conversation = [
				{ from: "alice", to: ["bob"], body: "Hi Bob!" },
				{ from: "bob", to: ["alice"], body: "Hey Alice!" },
				{ from: "alice", to: ["bob"], body: "How are you?" },
				{ from: "bob", to: ["alice"], body: "Good! You?" },
				{ from: "alice", to: ["bob"], body: "Great!" },
			]

			for (let i = 0; i < conversation.length; i++) {
				write({ ops: [{ fn: "sendMessage", args: [{ id: `msg${i}`, ...conversation[i] }] }] })
			}

			// Alice sent 3 messages, received 2
			assert.equal(getOutbox(db, "alice").length, 3)
			assert.equal(getInbox(db, "alice").length, 2)
			assert.equal(getMessages(db, "alice").length, 5)

			// Bob sent 2 messages, received 3
			assert.equal(getOutbox(db, "bob").length, 2)
			assert.equal(getInbox(db, "bob").length, 3)
			assert.equal(getMessages(db, "bob").length, 5)
		})

		it("group message to multiple recipients", () => {
			resetIds()
			const { db, write } = createServer()

			const users = ["alice", "bob", "charlie", "diana"]
			for (const userId of users) {
				write({
					ops: [{ fn: "createUser", args: [{ id: userId, name: userId.charAt(0).toUpperCase() + userId.slice(1) }] }],
				})
			}

			write({
				ops: [
					{
						fn: "sendMessage",
						args: [{ id: "group-msg", from: "alice", to: ["bob", "charlie", "diana"], body: "Group announcement!" }],
					},
				],
			})

			// Sender has outbox, no inbox
			assert.equal(getOutbox(db, "alice").length, 1)
			assert.equal(getInbox(db, "alice").length, 0)

			// All recipients have inbox and unread
			for (const userId of ["bob", "charlie", "diana"]) {
				assert.equal(getInbox(db, userId).length, 1, `${userId} should have 1 inbox entry`)
				assert.equal(getUnread(db, userId).length, 1, `${userId} should have 1 unread entry`)
			}
		})
	})

	describe("History Tracking", () => {
		it("records operations in history with correct clock sequence", () => {
			resetIds()
			const { db, write } = createServer()

			write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })
			write({ ops: [{ fn: "sendMessage", args: [{ id: "msg1", from: "alice", to: ["bob"], body: "Hello!" }] }] })
			write({ ops: [{ fn: "sendMessage", args: [{ id: "msg2", from: "bob", to: ["alice"], body: "Hi!" }] }] })

			// Alice's history: profile, sendMessage, receiveMessage
			const aliceHistory = getHistory(db, ["users", "alice"])
			assert.equal(aliceHistory.length, 3)
			assert.equal(aliceHistory[0].clock, 1)
			assert.equal(aliceHistory[1].clock, 2)
			assert.equal(aliceHistory[2].clock, 3)

			// Verify operation types
			assert.equal(aliceHistory[0].ops[0].fn, "setProfile")
			assert.equal(aliceHistory[1].ops[0].fn, "sendMessage")
			assert.equal(aliceHistory[2].ops[0].fn, "receiveMessage")
		})

		it("maintains separate history per user scope", () => {
			resetIds()
			const { db, write } = createServer()

			write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })
			write({ ops: [{ fn: "sendMessage", args: [{ id: "msg1", from: "alice", to: ["bob"], body: "Hello!" }] }] })

			const aliceHistory = getHistory(db, ["users", "alice"])
			const bobHistory = getHistory(db, ["users", "bob"])

			// Alice: profile + sendMessage
			assert.equal(aliceHistory.length, 2)

			// Bob: profile + receiveMessage + addUnread (in same commit)
			assert.equal(bobHistory.length, 2)
			assert.equal(bobHistory[1].ops.length, 2) // receiveMessage and addUnread
		})
	})

	describe("Edge Cases", () => {
		it("idempotent message sending with same commit id", () => {
			resetIds()
			const { db, write } = createServer()

			write({ ops: [{ fn: "createUser", args: [{ id: "alice", name: "Alice" }] }] })
			write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })

			const msg = { id: "msg1", from: "alice", to: ["bob"], body: "Hello!" }

			// Send same commit twice
			write({ id: "tx-send", ops: [{ fn: "sendMessage", args: [msg] }] })
			write({ id: "tx-send", ops: [{ fn: "sendMessage", args: [msg] }] })

			// Should only have one message
			assert.equal(getInbox(db, "bob").length, 1)
			assert.equal(getMessages(db, "bob").length, 1)
		})

		it("handles marking non-existent message as read gracefully", () => {
			resetIds()
			const { db, write } = createServer()

			write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })

			// Mark non-existent message as read - should not throw
			write({ ops: [{ fn: "markRead", args: [{ messageId: "nonexistent", userId: "bob" }] }] })

			assert.deepEqual(getUnread(db, "bob"), [])
		})

		it("handles deleting non-existent message gracefully", () => {
			resetIds()
			const { db, write } = createServer()

			write({ ops: [{ fn: "createUser", args: [{ id: "bob", name: "Bob" }] }] })

			// Delete non-existent message - should not throw
			write({ ops: [{ fn: "delete", args: [{ type: "message", id: "nonexistent", userId: "bob" }] }] })

			assert.equal(getMessages(db, "bob").length, 0)
		})
	})
})
