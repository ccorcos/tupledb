import { PubsubHarness } from "fixtures/PubsubHarness"
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { randomId } from "shared/randomId"
import { PubsubServerApi } from "syncDb/PubSub"
import { Commit, CommitArgs, CommitMeta, Op, ReducerMap } from "syncDb/types"
import { tupleDb, tupleTx } from "tupleDb/TupleDb"
import { ListArgs, Tuple, TupleDb } from "tupleDb/types"

type TodoList = {
	id: string
	name: string
	editedAt: string
}

type Todo = {
	id: string
	listId: string
	text: string
	checked: boolean
	order: string // Fractional index
}

// syncDb at ["todoList", listId]
const todoListReducers = {
	setList: (tx: TupleDb, commit: CommitMeta, list: TodoList) => {
		tx.set([], list)
	},

	setTodo: (tx: TupleDb, commit: CommitMeta, todo: Todo) => {
		// Handle upsert
		todoListReducers.deleteTodo(tx, commit, todo.id)

		tx.set(["todo", todo.id], todo)

		tx.set(["all", todo.order, todo.id], null)
		if (todo.checked) tx.set(["checked", todo.order, todo.id], null)
		else tx.set(["unchecked", todo.order, todo.id], null)
	},

	deleteTodo: (tx: TupleDb, commit: CommitMeta, todoId: string) => {
		const todo = tx.get(["todo", todoId]) as Todo | undefined
		if (!todo) return
		tx.delete(["todo", todoId])

		tx.delete(["all", todo.order, todoId])
		if (todo.checked) tx.delete(["checked", todo.order, todoId])
		else tx.delete(["unchecked", todo.order, todoId])
	},
} satisfies ReducerMap

// syncDb at ["users", userId]
const userReducers = {
	setList: (tx: TupleDb, commit: CommitMeta, list: TodoList) => {
		// Handle upsert
		userReducers.removeList(tx, commit, list.id)

		tx.set(["listByEditedAt", list.editedAt, list.id], null)
		tx.set(["list", list.id], list)
	},

	updateEditedAt: (tx: TupleDb, commit: CommitMeta, listId: string, editedAt: string) => {
		const list = tx.get(["list", listId])
		if (!list) return
		tx.delete(["listByEditedAt", list.editedAt, list.id])
		tx.set(["listByEditedAt", editedAt, list.id], null)
	},

	removeList: (tx: TupleDb, commit: CommitMeta, listId: string) => {
		const list = tx.get(["list", listId])
		if (!list) return

		tx.delete(["listByEditedAt", list.editedAt, list.id])
		tx.delete(["list", list.id])
	},
} satisfies ReducerMap


function pubsubQueue(db: TupleDb) {
	return {
		enqueue(timestamp: string, key: Tuple, value: any) {
			db.set(["_publish", timestamp, key], value)
		},
		dequeue() {
			const items = db.subspace(["_publish"]).list({ limit: 1000 })
			return {
				items: items.map(({ key, value }) => ({ key: key.at(-1), value })),
				clear() {
					db.subspace(["_publish"]).write({ delete: items.map(({ key }) => key) })
				}
			}
		}
	}
}

function applySyncCommit(db: TupleDb, path: Tuple, reducers: ReducerMap, commit: CommitMeta & { ops: Op[] }) {
	const node = db.subspace(path)

	const clock = (node.get(["clock"]) || -1) + 1
	node.set(["clock"], clock)

	const finalCommit: Commit = { ...commit, clock }
	node.set(["history", clock], finalCommit)

	const { ops, ...meta } = commit
	for (const op of ops) {
		const reducer = reducers[op.fn]
		if (!reducer) throw new Error(`Unknown operation: ${op.fn}`)
		reducer(node.subspace(["data"]), meta, op.args)
	}

	// commitedAt only exists on the server, not on the client.
	if (commit.commitedAt) {
		pubsubQueue(db).enqueue(commit.commitedAt, [...path, "clock"], clock)
	}
}

const todoAppReducers = {
	setList: (tx: TupleDb, commit: CommitMeta, list: TodoList) => {
		if (!commit.authorId) throw new Error("You need to be logged in.")
		const userId = commit.authorId

		applySyncCommit(tx, ["users", userId], userReducers, {
			...commit,
			ops: [{ fn: "setList", args: [list] }],
		})

		applySyncCommit(tx, ["todoList", list.id], todoListReducers, {
			...commit,
			ops: [{ fn: "setList", args: [list] }],
		})
	},

	// Soft delete so we can undo, so that sync works, etc.
	removeList: (tx: TupleDb, commit: CommitMeta, listId: string) => {
		if (!commit.authorId) throw new Error("You need to be logged in.")
		const userId = commit.authorId

		applySyncCommit(tx, ["users", userId], userReducers, {
			...commit,
			ops: [{ fn: "removeList", args: [listId] }],
		})
	},

	addTodo: (tx: TupleDb, commit: CommitMeta, todo: Todo) => {
		applySyncCommit(tx, ["todoList", todo.listId], todoListReducers, {
			...commit,
			ops: [{ fn: "setTodo", args: [todo] }],
		})
	},

	deleteTodo: (
		tx: TupleDb,
		commit: CommitMeta,
		args: { listId: string; todoId: string }
	) => {
		const { listId, todoId } = args
		applySyncCommit(tx, ["todoList", listId], todoListReducers, {
			...commit,
			ops: [{ fn: "deleteTodo", args: [todoId] }],
		})
	},
} satisfies ReducerMap

// Type for app reducers
type TodoAppReducers = typeof todoAppReducers



function appDb(db: TupleDb, reducers: ReducerMap) {
	return {
		// // `sync` could just be an explicit history range request to list.
		// sync(path: Tuple, since: number) {
		// 	const node = db.subspace(path)
		// 	const clock = node.get(["clock"])
		// 	const updates = node.subspace(["history"]).list({ gt: [since] })
		// 	return { clock, updates }
		// },

		// Return the clock with every read so we can ensure consistency.
		list(path: Tuple, range: ListArgs<Tuple>) {
			const node = db.subspace(path)
			const clock = node.get(["clock"])
			// Range can fetch from history or data subspaces!
			const data = node.list(range)
			return { clock, data }
		},

		// Apply writes with idempotency.
		write(commit: CommitArgs) {
			const tx = tupleTx(db)

			const commitedAt = new Date().toISOString()

			if (commit.id) {
				if (tx.get(["_seen", commit.id])) return
				tx.set(["_seen", commit.id], commitedAt)
			}

			const meta: CommitMeta = {
				id: commit.id || randomId(),
				commitedAt,
				authorId: commit.authorId,
				createdAt: commit.createdAt,
			}

			for (const op of commit.ops) {
				const reducer = reducers[op.fn]
				if (!reducer) throw new Error(`Unknown operation: ${op.fn}`)
				reducer(tx, meta, op.args)
			}

			tx.commit()
		}
	}
}

function publish(db: TupleDb, pubsub: PubsubServerApi) {
	while (true) {
		const { items, clear } = pubsubQueue(db).dequeue()
		if (items.length === 0) break
		for (const { key, value } of items) pubsub.publish(key, value)
		clear()
	}
}

function server() {
	const db = tupleDb()
	const pubsub = new PubsubHarness()
	const app = appDb(db, todoAppReducers)
	const api = {
		list: app.list,
		write(args: CommitArgs) {
			app.write(args)
			publish(db, pubsub)
		}
	}
	return { db, api }
}



describe("TodoMVC", () => {



	it("works", () => {
		const { api } = server()
		api.write({ ops: [{ fn: "setList", args: [{ id: "list1", name: "My Todos", editedAt: new Date().toISOString() }] }] })
		assert.deepEqual(true, true)

	})
})