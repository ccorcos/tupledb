import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { TupleDb } from "../tupleDb/types"
import { tupleDb } from "../tupleDb/TupleDb"
import { syncDb } from "./SyncDb"
import { Commit } from "./types"

describe("SyncDb Example", () => {
	it("simple messaging example with replication", () => {
		type User = { id: string; name: string }
		type Message = { id: string; datetime: string; fromId: string; toId: string[]; body: string }

		// Define reducers once
		const userReducers = (authorId: string) => ({
			setUser: (tx: TupleDb, user: User) => {
				tx.set([], user)
			},
			setMessage: (tx: TupleDb, message: Message) => {
				tx.set(["message", message.id], message)
				if (message.fromId === authorId) {
					tx.set(["sent", message.datetime, message.id], null)
				} else {
					tx.set(["inbox", message.datetime, message.id], null)
				}
			},
		})

		// Helper to create server-side DBs for users
		const createUserDb = (db: TupleDb, userId: string) => 
			syncDb(db.subspace(["user", userId]), userReducers(userId))

		const db = tupleDb()

		// 1. Writes with Metadata
		// ======================================================================
		
		// To perform a write, we use the SyncDb instance. 
		// We can use the generated methods (setUser) which create a commit internally.
		const user1Db = createUserDb(db, "user1")
		user1Db.setUser({ id: "user1", name: "John" })

		// Or we can explicitly call write for more control (e.g. metadata)
		const user2Db = createUserDb(db, "user2")
		user2Db.write({
			authorId: "user2",
			ops: [{ fn: "setUser", args: { id: "user2", name: "Jane" } }]
		})

		const user3Db = createUserDb(db, "user3")
		user3Db.setUser({ id: "user3", name: "Jim" })

		// Verify data
		assert.deepEqual(user1Db.data.get([]), { id: "user1", name: "John" })

		// Complex transaction (Message)
		const message: Message = {
			id: "msg1",
			datetime: "2021-01-01",
			fromId: "user2",
			toId: ["user1", "user3"],
			body: "Hello friends!",
		}

		// User2 sends a message
		// This involves writing to User2's DB and recipients' DBs.
		// In a real system, this might be distributed. Here we simulate the logic.
		
		const sendMsgTx = (msg: Message) => {
			// 1. Sender's Outbox
			const senderDb = createUserDb(db, msg.fromId)
			senderDb.setMessage(msg)

			// 2. Recipients' Inboxes
			for (const userId of msg.toId) {
				const recipientDb = createUserDb(db, userId)
				// We can include causal info or original author in metadata
				recipientDb.write({
					authorId: msg.fromId,
					ops: [{ fn: "setMessage", args: msg }]
				})
			}
		}

		sendMsgTx(message)

		// Verify Inbox of User1
		assert.equal((user1Db.data.get(["message", "msg1"]) as Message).body, "Hello friends!")


		// 2. Replication (Full Replica)
		// ======================================================================
		
		const replicaDb = tupleDb()
		
		function replicateUser(userId: string) {
			const primary = createUserDb(db, userId)
			const replica = createUserDb(replicaDb, userId)

			// Get new commits from primary
			// replica.clock() tells us what we have processed so far
			const newCommits = primary.history.list({ gt: [replica.clock()] })

			for (const { value } of newCommits) {
				const commit = value as Commit
				// We apply the commit exactly as is (preserving clock, timestamp, etc.)
				replica.write(commit)
			}
		}

		// Replicate all users
		replicateUser("user1")
		replicateUser("user2")
		replicateUser("user3")

		// Verify Replica
		const replicaUser1 = createUserDb(replicaDb, "user1")
		assert.deepEqual(replicaUser1.data.get([]), { id: "user1", name: "John" })
		assert.equal(replicaUser1.clock(), user1Db.clock())


		// 3. Client Sync (Partial/Offline)
		// ======================================================================
		
		// Client has their own local DB
		const clientDb = tupleDb()
		const clientUser1 = createUserDb(clientDb, "user1")

		// A. Pull from Server (Initial Sync)
		const serverHistory = user1Db.history.list({ gt: [clientUser1.clock()] })
		for (const { value } of serverHistory) {
			clientUser1.write(value as Commit)
		}

		assert.equal(clientUser1.clock(), user1Db.clock())
		assert.deepEqual(clientUser1.data.get([]), { id: "user1", name: "John" })

		// B. Client makes Offline Write
		clientUser1.setUser({ id: "user1", name: "John Doe" }) // Update name
		
		// Client clock increments locally
		const clientLocalClock = clientUser1.clock()
		assert.equal(clientLocalClock, user1Db.clock() + 1)

		// C. Push to Server
		// Client sends the *ops*, not the full commit (because server dictates clock)
		const clientUnsynced = clientUser1.history.list({ gt: [user1Db.clock()] })
		
		for (const { value } of clientUnsynced) {
			const localCommit = value as Commit
			
			// Server applies the ops
			// In a real app, server would handle conflict resolution or rebase here.
			// Here we just accept the write.
			user1Db.write({
				id: localCommit.id, // Preserve ID for idempotency/tracking
				ops: localCommit.ops
			})
		}

		// Server clock should have advanced
		assert.equal(user1Db.clock(), clientLocalClock)
		assert.deepEqual(user1Db.data.get([]), { id: "user1", name: "John Doe" })

		// In a real client, we would now pull the new server commit 
		// and confirm it matches our local optimistic commit.
	})
})