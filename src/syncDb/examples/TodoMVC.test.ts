import { PubsubHarness } from "fixtures/PubsubHarness"
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { appDb, publish } from "../SyncNode"
import { tupleDb } from "../../tupleDb/TupleDb"
import { Tuple, TupleDb } from "../../tupleDb/types"
import { todoAppReducers, Todo, TodoList } from "./TodoMVC"
import { Commit } from "../types"

// ============================================================================
// Test Helpers
// ============================================================================

function createServer() {
	const db = tupleDb()
	const pubsub = new PubsubHarness()
	const app = appDb(db, todoAppReducers)

	return {
		db,
		write(args: Parameters<typeof app.write>[0]) {
			app.write(args)
			publish(db, pubsub)
		},
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

function createList(overrides: Partial<TodoList> = {}): TodoList {
	return {
		id: nextId("list"),
		name: "My List",
		editedAt: new Date().toISOString(),
		...overrides,
	}
}

function createTodo(listId: string, overrides: Partial<Todo> = {}): Todo {
	return {
		id: nextId("todo"),
		listId,
		text: "Do something",
		checked: false,
		order: "a",
		...overrides,
	}
}

// ============================================================================
// Query Helpers - Clean accessors for test assertions
// ============================================================================

function getUserLists(db: TupleDb, userId: string): TodoList[] {
	const data = getData(db, ["users", userId])
	return data.filter((d) => d.key[0] === "list").map((d) => d.value as TodoList)
}

function getUserListsByEditedAt(db: TupleDb, userId: string): string[] {
	const data = getData(db, ["users", userId])
	return data
		.filter((d) => d.key[0] === "listByEditedAt")
		.map((d) => d.key[2] as string) // [editedAt, listId] -> listId
}

function getListData(db: TupleDb, listId: string): TodoList | undefined {
	const data = getData(db, ["todoList", listId])
	const entry = data.find((d) => d.key.length === 0)
	return entry?.value as TodoList | undefined
}

function getTodos(db: TupleDb, listId: string): Todo[] {
	const data = getData(db, ["todoList", listId])
	return data.filter((d) => d.key[0] === "todo").map((d) => d.value as Todo)
}

function getTodoById(db: TupleDb, listId: string, todoId: string): Todo | undefined {
	const data = getData(db, ["todoList", listId])
	const entry = data.find((d) => d.key[0] === "todo" && d.key[1] === todoId)
	return entry?.value as Todo | undefined
}

function getTodosByOrder(db: TupleDb, listId: string): string[] {
	const data = getData(db, ["todoList", listId])
	return data.filter((d) => d.key[0] === "all").map((d) => d.key[2] as string) // [order, todoId] -> todoId
}

function getCheckedTodos(db: TupleDb, listId: string): string[] {
	const data = getData(db, ["todoList", listId])
	return data.filter((d) => d.key[0] === "checked").map((d) => d.key[2] as string)
}

function getUncheckedTodos(db: TupleDb, listId: string): string[] {
	const data = getData(db, ["todoList", listId])
	return data.filter((d) => d.key[0] === "unchecked").map((d) => d.key[2] as string)
}

// ============================================================================
// Tests
// ============================================================================

describe("TodoMVC", () => {
	describe("List Operations", () => {
		it("creates a list", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1", name: "Shopping" })

			write({
				authorId: "user-1",
				ops: [{ fn: "setList", args: [list] }],
			})

			// List appears in user's lists
			const userLists = getUserLists(db, "user-1")
			assert.equal(userLists.length, 1)
			assert.equal(userLists[0].name, "Shopping")

			// List has its own data node
			const listData = getListData(db, "list-1")
			assert.ok(listData)
			assert.equal(listData.name, "Shopping")
		})

		it("deletes a list", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1", name: "Shopping" })

			// Create then remove
			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })
			write({ authorId: "user-1", ops: [{ fn: "removeList", args: ["list-1"] }] })

			// List removed from user's lists
			const userLists = getUserLists(db, "user-1")
			assert.equal(userLists.length, 0)

			// Index also cleaned up
			const byEditedAt = getUserListsByEditedAt(db, "user-1")
			assert.equal(byEditedAt.length, 0)
		})

		it("updates a list name", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1", name: "Shopping" })

			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })

			// Update name
			const updatedList = { ...list, name: "Groceries" }
			write({ authorId: "user-1", ops: [{ fn: "setList", args: [updatedList] }] })

			const userLists = getUserLists(db, "user-1")
			assert.equal(userLists.length, 1)
			assert.equal(userLists[0].name, "Groceries")

			const listData = getListData(db, "list-1")
			assert.equal(listData?.name, "Groceries")
		})
	})

	describe("Todo Operations", () => {
		it("creates a todo", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Buy milk" })

			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [todo] }] })

			const todos = getTodos(db, "list-1")
			assert.equal(todos.length, 1)
			assert.equal(todos[0].text, "Buy milk")
			assert.equal(todos[0].checked, false)
		})

		it("deletes a todo", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Buy milk" })

			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [todo] }] })
			write({
				authorId: "user-1",
				ops: [{ fn: "deleteTodo", args: [{ listId: "list-1", todoId: "todo-1" }] }],
			})

			const todos = getTodos(db, "list-1")
			assert.equal(todos.length, 0)

			// Indexes also cleaned up
			assert.equal(getTodosByOrder(db, "list-1").length, 0)
			assert.equal(getUncheckedTodos(db, "list-1").length, 0)
		})

		it("renames a todo", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Buy milk" })

			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [todo] }] })

			// Rename by re-adding with same id
			const renamedTodo = { ...todo, text: "Buy oat milk" }
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [renamedTodo] }] })

			const todos = getTodos(db, "list-1")
			assert.equal(todos.length, 1)
			assert.equal(todos[0].text, "Buy oat milk")
		})

		it("checks a todo", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Buy milk", checked: false })

			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [todo] }] })

			// Initially unchecked
			assert.deepEqual(getUncheckedTodos(db, "list-1"), ["todo-1"])
			assert.deepEqual(getCheckedTodos(db, "list-1"), [])

			// Check the todo
			const checkedTodo = { ...todo, checked: true }
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [checkedTodo] }] })

			const updatedTodo = getTodoById(db, "list-1", "todo-1")
			assert.equal(updatedTodo?.checked, true)

			// Indexes updated correctly
			assert.deepEqual(getUncheckedTodos(db, "list-1"), [])
			assert.deepEqual(getCheckedTodos(db, "list-1"), ["todo-1"])
		})

		it("unchecks a todo", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", checked: true })

			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [todo] }] })

			// Initially checked
			assert.deepEqual(getCheckedTodos(db, "list-1"), ["todo-1"])

			// Uncheck the todo
			const uncheckedTodo = { ...todo, checked: false }
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [uncheckedTodo] }] })

			assert.deepEqual(getCheckedTodos(db, "list-1"), [])
			assert.deepEqual(getUncheckedTodos(db, "list-1"), ["todo-1"])
		})

		it("reorders todos", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1" })

			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })

			// Create three todos in order
			const todoA = createTodo("list-1", { id: "todo-a", text: "First", order: "a" })
			const todoB = createTodo("list-1", { id: "todo-b", text: "Second", order: "b" })
			const todoC = createTodo("list-1", { id: "todo-c", text: "Third", order: "c" })

			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [todoA] }] })
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [todoB] }] })
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [todoC] }] })

			// Verify initial order
			assert.deepEqual(getTodosByOrder(db, "list-1"), ["todo-a", "todo-b", "todo-c"])

			// Move C to the front (before A)
			const reorderedC = { ...todoC, order: "0" } // "0" < "a"
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [reorderedC] }] })

			assert.deepEqual(getTodosByOrder(db, "list-1"), ["todo-c", "todo-a", "todo-b"])
		})

		it("reorders a todo between two others using fractional indexing", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1" })

			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })

			const todoA = createTodo("list-1", { id: "todo-a", order: "a" })
			const todoB = createTodo("list-1", { id: "todo-b", order: "c" })
			const todoC = createTodo("list-1", { id: "todo-c", order: "e" })

			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [todoA] }] })
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [todoB] }] })
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [todoC] }] })

			// Move C between A and B
			const reorderedC = { ...todoC, order: "b" } // "a" < "b" < "c"
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [reorderedC] }] })

			assert.deepEqual(getTodosByOrder(db, "list-1"), ["todo-a", "todo-c", "todo-b"])
		})
	})

	describe("EditedAt Tracking", () => {
		it("updating list editedAt updates the index", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1", editedAt: "2024-01-01T00:00:00Z" })

			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })

			// Update with new editedAt
			const updatedList = { ...list, editedAt: "2024-01-02T00:00:00Z" }
			write({ authorId: "user-1", ops: [{ fn: "setList", args: [updatedList] }] })

			// Check user's list index is updated
			const data = getData(db, ["users", "user-1"])
			const byEditedAt = data.filter((d) => d.key[0] === "listByEditedAt")

			// Should only have one entry with the new editedAt
			assert.equal(byEditedAt.length, 1)
			assert.equal(byEditedAt[0].key[1], "2024-01-02T00:00:00Z")
		})

		it("multiple lists are ordered by editedAt", () => {
			resetIds()
			const { db, write } = createServer()

			const list1 = createList({ id: "list-1", name: "Oldest", editedAt: "2024-01-01T00:00:00Z" })
			const list2 = createList({ id: "list-2", name: "Middle", editedAt: "2024-01-02T00:00:00Z" })
			const list3 = createList({ id: "list-3", name: "Newest", editedAt: "2024-01-03T00:00:00Z" })

			// Add in random order
			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list2] }] })
			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list1] }] })
			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list3] }] })

			// Should be ordered by editedAt (oldest first due to lexicographic ordering)
			const orderedIds = getUserListsByEditedAt(db, "user-1")
			assert.deepEqual(orderedIds, ["list-1", "list-2", "list-3"])
		})
	})

	describe("History Tracking", () => {
		it("records operations in history with correct clock sequence", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1" })

			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })

			const todo1 = createTodo("list-1", { id: "todo-1", text: "First" })
			const todo2 = createTodo("list-1", { id: "todo-2", text: "Second" })

			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [todo1] }] })
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [todo2] }] })

			// Check todoList history
			const listHistory = getHistory(db, ["todoList", "list-1"])
			assert.equal(listHistory.length, 3)

			// Clock should be sequential
			assert.equal(listHistory[0].clock, 1)
			assert.equal(listHistory[1].clock, 2)
			assert.equal(listHistory[2].clock, 3)

			// Operations recorded correctly
			assert.equal(listHistory[0].ops[0].fn, "setList")
			assert.equal(listHistory[1].ops[0].fn, "setTodo")
			assert.equal(listHistory[2].ops[0].fn, "setTodo")
		})

		it("maintains separate history for user and list scopes", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1" })

			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })

			const todo = createTodo("list-1", { id: "todo-1" })
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [todo] }] })

			// User scope history: only setList
			const userHistory = getHistory(db, ["users", "user-1"])
			assert.equal(userHistory.length, 1)
			assert.equal(userHistory[0].ops[0].fn, "setList")

			// List scope history: setList and setTodo
			const listHistory = getHistory(db, ["todoList", "list-1"])
			assert.equal(listHistory.length, 2)
		})

		it("preserves author information in history", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1" })

			write({ authorId: "alice", ops: [{ fn: "setList", args: [list] }] })

			const todo = createTodo("list-1", { id: "todo-1" })
			write({ authorId: "bob", ops: [{ fn: "addTodo", args: [todo] }] })

			const listHistory = getHistory(db, ["todoList", "list-1"])

			assert.equal(listHistory[0].authorId, "alice")
			assert.equal(listHistory[1].authorId, "bob")
		})

		it("history records each modification as separate entry", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Original", checked: false })

			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [todo] }] })

			// Rename
			write({ authorId: "user-1", ops: [{ fn: "addTodo", args: [{ ...todo, text: "Renamed" }] }] })

			// Check
			write({
				authorId: "user-1",
				ops: [{ fn: "addTodo", args: [{ ...todo, text: "Renamed", checked: true }] }],
			})

			// Delete
			write({
				authorId: "user-1",
				ops: [{ fn: "deleteTodo", args: [{ listId: "list-1", todoId: "todo-1" }] }],
			})

			const listHistory = getHistory(db, ["todoList", "list-1"])
			assert.equal(listHistory.length, 5) // setList + 3 setTodo + deleteTodo

			// Verify operation sequence
			const ops = listHistory.map((h) => h.ops[0].fn)
			assert.deepEqual(ops, ["setList", "setTodo", "setTodo", "setTodo", "deleteTodo"])
		})
	})

	describe("Edge Cases", () => {
		it("handles deleting a non-existent todo gracefully", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1" })

			write({ authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })

			// Delete todo that doesn't exist - should not throw
			write({
				authorId: "user-1",
				ops: [{ fn: "deleteTodo", args: [{ listId: "list-1", todoId: "nonexistent" }] }],
			})

			assert.equal(getTodos(db, "list-1").length, 0)
		})

		it("handles removing a non-existent list gracefully", () => {
			resetIds()
			const { db, write } = createServer()

			// Remove list that doesn't exist - should not throw
			write({ authorId: "user-1", ops: [{ fn: "removeList", args: ["nonexistent"] }] })

			assert.equal(getUserLists(db, "user-1").length, 0)
		})

		it("requires authorId for list operations", () => {
			resetIds()
			const { write } = createServer()
			const list = createList({ id: "list-1" })

			assert.throws(() => {
				write({ ops: [{ fn: "setList", args: [list] }] })
			}, /You need to be logged in/)
		})

		it("idempotent writes with same commit id", () => {
			resetIds()
			const { db, write } = createServer()
			const list = createList({ id: "list-1" })

			// Write same commit twice with same id
			write({ id: "commit-1", authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })
			write({ id: "commit-1", authorId: "user-1", ops: [{ fn: "setList", args: [list] }] })

			// Should only have one list
			assert.equal(getUserLists(db, "user-1").length, 1)

			// History should only have one entry
			const listHistory = getHistory(db, ["todoList", "list-1"])
			assert.equal(listHistory.length, 1)
		})
	})
})
