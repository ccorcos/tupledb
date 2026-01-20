import { pubsubQueue } from "syncDb/pubsub"
import { Tuple, TupleDb } from "../../tupleDb/types"
import { syncDb } from "../syncDb"
import { CommitMeta, Op, ReducerMap } from "../types"

export type TodoList = {
	id: string
	name: string
	editedAt: string
}

export type Todo = {
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


function writeSyncDb<R extends ReducerMap>(tx: TupleDb, path: Tuple, commit: CommitMeta, reducers: R, ops: Op<R>[]) {
	syncDb(tx.subspace(path), reducers).apply({ ...commit, ops })
	if (commit.commitedAt) {
		pubsubQueue(tx).enqueue(commit.commitedAt, path, tx.get([...path, "clock"]))
	}
}

export const todoAppReducers = {
	setList: (tx: TupleDb, commit: CommitMeta, list: TodoList) => {
		if (!commit.authorId) throw new Error("You need to be logged in.")
		const userId = commit.authorId
		writeSyncDb(tx, ["users", userId], commit, userReducers, [{ fn: "setList", args: [list] }])
		writeSyncDb(tx, ["todoList", list.id], commit, todoListReducers, [{ fn: "setList", args: [list] }])
	},

	// Soft delete so we can undo, so that sync works, etc.
	removeList: (tx: TupleDb, commit: CommitMeta, listId: string) => {
		if (!commit.authorId) throw new Error("You need to be logged in.")
		const userId = commit.authorId
		writeSyncDb(tx, ["users", userId], commit, userReducers, [{ fn: "removeList", args: [listId] }])
	},

	addTodo: (tx: TupleDb, commit: CommitMeta, todo: Todo) => {
		writeSyncDb(tx, ["todoList", todo.listId], commit, todoListReducers, [{ fn: "setTodo", args: [todo] }])
	},

	deleteTodo: (
		tx: TupleDb,
		commit: CommitMeta,
		args: { listId: string; todoId: string }
	) => {
		const { listId, todoId } = args
		writeSyncDb(tx, ["todoList", listId], commit, todoListReducers, [{ fn: "deleteTodo", args: [todoId] }])
	},
} satisfies ReducerMap

// Type for app reducers
type TodoAppReducers = typeof todoAppReducers



