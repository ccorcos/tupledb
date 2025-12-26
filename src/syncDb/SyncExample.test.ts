import { describe, it } from "node:test"
import { TupleDb } from "tupleDb/types"
import { tupleDb } from "../tupleDb/TupleDb"
import { syncDb } from "./SyncDb"

describe("SyncDb Example", () => {
	it("simple messaging example", () => {
		type User = { id: string; name: string }
		type Message = { id: string; datetime: string; fromId: string; toId: string[]; body: string }

		//
		const serverReducers = (authorId: string) => ({
			setUser: (tx: TupleDb, user: User) => {
				if (user.id !== authorId) throw new Error("You can only set your own user.")
				const userDb = syncDb(tx.subspace(["user", user.id]), userReducers(authorId))
				userDb.data.setUser(user)
			},
			setMessage: (tx: TupleDb, message: Message) => {
				if (message.fromId !== authorId) throw new Error("You can only set your own message.")

				const fromDb = syncDb(tx.subspace(["user", message.fromId]), userReducers(authorId))
				fromDb.data.setMessage(message)
				for (const userId of message.toId) {
					const toDb = syncDb(tx.subspace(["user", userId]), userReducers(userId))
					toDb.data.setMessage(message)
				}
			},
		})

		// This is a simple write abstraction for tupleDb.
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

		const db = tupleDb()

		// TODO: where's the metadata for this write? transaction id?
		serverReducers("user1").setUser(db, { id: "user1", name: "John" })
		serverReducers("user2").setUser(db, { id: "user2", name: "Jane" })
		serverReducers("user3").setUser(db, { id: "user3", name: "Jim" })

		const message: Message = {
			id: "msg1",
			datetime: "2021-01-01",
			fromId: "user2",
			toId: ["user1", "user3"],
			body: "Hello friends!",
		}
		serverReducers("user2").setMessage(db, message)

		// console.log(JSON.stringify(db.list(), null, 2))

		// TODO: how to sync this data to a full replica?
		// TODO: how to sync this to a client?
	})
})
