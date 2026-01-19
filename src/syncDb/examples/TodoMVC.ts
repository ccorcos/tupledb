import { generateKeyBetween } from "fractional-indexing"
import { Tuple, TupleDb } from "../../tupleDb/types"
import { applySyncCommit } from "../SyncNode"
import { CommitMeta, ReducerMap } from "../types"

// =============================================================================
// Types
// =============================================================================

export type TodoList = {
	id: string
	name: string
}

export type Todo = {
	id: string
	text: string
	checked: boolean
	order: string // Fractional index for ordering
}

// =============================================================================
// Scope Reducers: TodoList (at ["todoList", listId])
// =============================================================================

export const todoListReducers: ReducerMap = {
	init: (tx: TupleDb, _commit: CommitMeta, list: TodoList) => {
		tx.set(["info"], list)
	},

	addTodo: (tx: TupleDb, _commit: CommitMeta, todo: Todo) => {
		tx.set(["todo", todo.id], todo)
		// Index by order for all todos
		tx.set(["all", todo.order, todo.id], null)
		// Index by checked status
		if (todo.checked) {
			tx.set(["checked", todo.order, todo.id], null)
		} else {
			tx.set(["unchecked", todo.order, todo.id], null)
		}
	},

	updateTodo: (tx: TupleDb, _commit: CommitMeta, todo: Todo) => {
		const existing = tx.get(["todo", todo.id]) as Todo | undefined
		if (!existing) return

		// Remove old indexes
		tx.delete(["all", existing.order, todo.id])
		if (existing.checked) {
			tx.delete(["checked", existing.order, todo.id])
		} else {
			tx.delete(["unchecked", existing.order, todo.id])
		}

		// Write updated todo
		tx.set(["todo", todo.id], todo)

		// Add new indexes
		tx.set(["all", todo.order, todo.id], null)
		if (todo.checked) {
			tx.set(["checked", todo.order, todo.id], null)
		} else {
			tx.set(["unchecked", todo.order, todo.id], null)
		}
	},

	toggleTodo: (tx: TupleDb, _commit: CommitMeta, todoId: string) => {
		const todo = tx.get(["todo", todoId]) as Todo | undefined
		if (!todo) return

		// Update checked status
		const newChecked = !todo.checked
		tx.set(["todo", todoId], { ...todo, checked: newChecked })

		// Update indexes
		if (todo.checked) {
			tx.delete(["checked", todo.order, todoId])
			tx.set(["unchecked", todo.order, todoId], null)
		} else {
			tx.delete(["unchecked", todo.order, todoId])
			tx.set(["checked", todo.order, todoId], null)
		}
	},

	deleteTodo: (tx: TupleDb, _commit: CommitMeta, todoId: string) => {
		const todo = tx.get(["todo", todoId]) as Todo | undefined
		if (!todo) return

		tx.delete(["todo", todoId])
		tx.delete(["all", todo.order, todoId])
		if (todo.checked) {
			tx.delete(["checked", todo.order, todoId])
		} else {
			tx.delete(["unchecked", todo.order, todoId])
		}
	},

	reorderTodo: (tx: TupleDb, _commit: CommitMeta, todoId: string, newOrder: string) => {
		const todo = tx.get(["todo", todoId]) as Todo | undefined
		if (!todo) return

		// Remove old order indexes
		tx.delete(["all", todo.order, todoId])
		if (todo.checked) {
			tx.delete(["checked", todo.order, todoId])
		} else {
			tx.delete(["unchecked", todo.order, todoId])
		}

		// Update todo with new order
		const updated = { ...todo, order: newOrder }
		tx.set(["todo", todoId], updated)

		// Add new order indexes
		tx.set(["all", newOrder, todoId], null)
		if (todo.checked) {
			tx.set(["checked", newOrder, todoId], null)
		} else {
			tx.set(["unchecked", newOrder, todoId], null)
		}
	},
}

// =============================================================================
// Scope Reducers: User (at ["users", userId])
// =============================================================================

export const userReducers: ReducerMap = {
	addList: (tx: TupleDb, _commit: CommitMeta, order: string, listId: string) => {
		tx.set(["lists", order, listId], null)
		tx.set(["listMap", listId], order)
	},

	removeList: (tx: TupleDb, _commit: CommitMeta, listId: string) => {
		const order = tx.get(["listMap", listId]) as string | undefined
		if (order) {
			tx.delete(["lists", order, listId])
			tx.delete(["listMap", listId])
		}
	},
}

// =============================================================================
// App Reducers
// =============================================================================

export const todoAppReducers = {
	createList: (
		tx: TupleDb,
		commit: CommitMeta,
		args: { listId: string; name: string; userId: string }
	) => {
		const { listId, name, userId } = args
		const userScope: Tuple = ["users", userId]
		const listScope: Tuple = ["todoList", listId]

		// Determine order for the new list (append to end)
		const userNode = tx.subspace([...userScope, "data"])
		const existingLists = userNode.subspace(["lists"]).list({ reverse: true, limit: 1 })
		const lastOrder = existingLists[0]?.key[0] as string | undefined
		const order = generateKeyBetween(lastOrder, null)

		// Add list reference to user's scope
		applySyncCommit(tx, userScope, userReducers, {
			...commit,
			ops: [{ fn: "addList", args: [order, listId] }],
		})

		// Create the list itself
		applySyncCommit(tx, listScope, todoListReducers, {
			...commit,
			ops: [{ fn: "init", args: [{ id: listId, name }] }],
		})
	},

	deleteList: (tx: TupleDb, commit: CommitMeta, args: { listId: string; userId: string }) => {
		const { listId, userId } = args
		const userScope: Tuple = ["users", userId]

		// Remove list reference from user's scope
		applySyncCommit(tx, userScope, userReducers, {
			...commit,
			ops: [{ fn: "removeList", args: [listId] }],
		})

		// Note: We don't delete the list data itself (could be shared with other users)
		// In a full implementation, you'd track list membership
	},

	addTodo: (tx: TupleDb, commit: CommitMeta, args: { listId: string; todo: Todo }) => {
		const { listId, todo } = args
		const listScope: Tuple = ["todoList", listId]

		applySyncCommit(tx, listScope, todoListReducers, {
			...commit,
			ops: [{ fn: "addTodo", args: [todo] }],
		})
	},

	updateTodo: (tx: TupleDb, commit: CommitMeta, args: { listId: string; todo: Todo }) => {
		const { listId, todo } = args
		const listScope: Tuple = ["todoList", listId]

		applySyncCommit(tx, listScope, todoListReducers, {
			...commit,
			ops: [{ fn: "updateTodo", args: [todo] }],
		})
	},

	toggleTodo: (tx: TupleDb, commit: CommitMeta, args: { listId: string; todoId: string }) => {
		const { listId, todoId } = args
		const listScope: Tuple = ["todoList", listId]

		applySyncCommit(tx, listScope, todoListReducers, {
			...commit,
			ops: [{ fn: "toggleTodo", args: [todoId] }],
		})
	},

	deleteTodo: (tx: TupleDb, commit: CommitMeta, args: { listId: string; todoId: string }) => {
		const { listId, todoId } = args
		const listScope: Tuple = ["todoList", listId]

		applySyncCommit(tx, listScope, todoListReducers, {
			...commit,
			ops: [{ fn: "deleteTodo", args: [todoId] }],
		})
	},

	reorderTodo: (
		tx: TupleDb,
		commit: CommitMeta,
		args: { listId: string; todoId: string; newOrder: string }
	) => {
		const { listId, todoId, newOrder } = args
		const listScope: Tuple = ["todoList", listId]

		applySyncCommit(tx, listScope, todoListReducers, {
			...commit,
			ops: [{ fn: "reorderTodo", args: [todoId, newOrder] }],
		})
	},
} satisfies ReducerMap

// Type for app reducers
export type TodoAppReducers = typeof todoAppReducers
