import { applySyncCommit } from "syncDb/SyncNode"
import { CommitMeta, ReducerMap } from "syncDb/types"
import { TupleDb } from "tupleDb/types"

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


export const todoAppReducers = {
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



