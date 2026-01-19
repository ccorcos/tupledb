import { generateKeyBetween } from "fractional-indexing"
import { PubsubHarness } from "fixtures/PubsubHarness"
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { appDb, publish } from "../SyncNode"
import { tupleDb } from "../../tupleDb/TupleDb"
import { Tuple, TupleDb } from "../../tupleDb/types"
import { Todo, todoAppReducers } from "./TodoMVC"

function server() {
	const db = tupleDb()
	const pubsub = new PubsubHarness()
	const app = appDb(db, todoAppReducers)
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

describe("TodoMVC", () => {
	describe("Server-side operations", () => {
		it("creates a list and adds it to user scope", () => {
			const { db, api } = server()

			api.write({
				ops: [{ fn: "createList", args: [{ listId: "list1", name: "My Todos", userId: "alice" }] }],
			})

			// Verify list was created
			const listData = getServerData(db, ["todoList", "list1"])
			assert.equal(listData.length, 1)
			assert.deepEqual(listData[0].value, { id: "list1", name: "My Todos" })

			// Verify user has reference to list
			const userData = getServerData(db, ["users", "alice"])
			assert.ok(userData.length >= 1)
			// Should have lists index and listMap entry
			const listMapEntry = userData.find((d) => d.key[0] === "listMap")
			assert.ok(listMapEntry)
			assert.equal(listMapEntry.key[1], "list1")
		})

		it("adds todos to a list with proper indexing", () => {
			const { db, api } = server()

			// Create list
			api.write({
				ops: [{ fn: "createList", args: [{ listId: "list1", name: "My Todos", userId: "alice" }] }],
			})

			// Add todos
			const todo1: Todo = {
				id: "todo1",
				text: "Buy milk",
				checked: false,
				order: generateKeyBetween(null, null),
			}
			const todo2: Todo = {
				id: "todo2",
				text: "Walk dog",
				checked: false,
				order: generateKeyBetween(todo1.order, null),
			}

			api.write({ ops: [{ fn: "addTodo", args: [{ listId: "list1", todo: todo1 }] }] })
			api.write({ ops: [{ fn: "addTodo", args: [{ listId: "list1", todo: todo2 }] }] })

			// Verify todos exist
			const listData = getServerData(db, ["todoList", "list1"])
			const todos = listData.filter((d) => d.key[0] === "todo")
			assert.equal(todos.length, 2)

			// Verify 'all' index
			const allIndex = listData.filter((d) => d.key[0] === "all")
			assert.equal(allIndex.length, 2)

			// Verify 'unchecked' index (both are unchecked)
			const uncheckedIndex = listData.filter((d) => d.key[0] === "unchecked")
			assert.equal(uncheckedIndex.length, 2)
		})

		it("toggles todo and updates indexes", () => {
			const { db, api } = server()

			// Create list and add todo
			api.write({
				ops: [{ fn: "createList", args: [{ listId: "list1", name: "My Todos", userId: "alice" }] }],
			})

			const todo: Todo = {
				id: "todo1",
				text: "Buy milk",
				checked: false,
				order: "a",
			}

			api.write({ ops: [{ fn: "addTodo", args: [{ listId: "list1", todo }] }] })

			// Initially unchecked
			let listData = getServerData(db, ["todoList", "list1"])
			let unchecked = listData.filter((d) => d.key[0] === "unchecked")
			let checked = listData.filter((d) => d.key[0] === "checked")
			assert.equal(unchecked.length, 1)
			assert.equal(checked.length, 0)

			// Toggle todo
			api.write({
				ops: [{ fn: "toggleTodo", args: [{ listId: "list1", todoId: "todo1" }] }],
			})

			// Now checked
			listData = getServerData(db, ["todoList", "list1"])
			unchecked = listData.filter((d) => d.key[0] === "unchecked")
			checked = listData.filter((d) => d.key[0] === "checked")
			assert.equal(unchecked.length, 0)
			assert.equal(checked.length, 1)

			// Verify todo data updated
			const todoData = listData.find((d) => d.key[0] === "todo" && d.key[1] === "todo1")
			assert.ok(todoData)
			assert.equal(todoData.value.checked, true)
		})

		it("deletes todo and removes from all indexes", () => {
			const { db, api } = server()

			// Setup
			api.write({
				ops: [{ fn: "createList", args: [{ listId: "list1", name: "My Todos", userId: "alice" }] }],
			})

			const todo: Todo = { id: "todo1", text: "Buy milk", checked: false, order: "a" }
			api.write({ ops: [{ fn: "addTodo", args: [{ listId: "list1", todo }] }] })

			// Verify exists
			let listData = getServerData(db, ["todoList", "list1"])
			assert.equal(listData.filter((d) => d.key[0] === "todo").length, 1)

			// Delete
			api.write({
				ops: [{ fn: "deleteTodo", args: [{ listId: "list1", todoId: "todo1" }] }],
			})

			// Verify removed from all indexes
			listData = getServerData(db, ["todoList", "list1"])
			assert.equal(listData.filter((d) => d.key[0] === "todo").length, 0)
			assert.equal(listData.filter((d) => d.key[0] === "all").length, 0)
			assert.equal(listData.filter((d) => d.key[0] === "unchecked").length, 0)
		})
	})

	describe("Complex scenarios", () => {
		it("user has multiple lists", () => {
			const { db, api } = server()

			// Create multiple lists for same user
			api.write({
				ops: [{ fn: "createList", args: [{ listId: "work", name: "Work Tasks", userId: "alice" }] }],
			})
			api.write({
				ops: [{ fn: "createList", args: [{ listId: "home", name: "Home Tasks", userId: "alice" }] }],
			})
			api.write({
				ops: [{ fn: "createList", args: [{ listId: "shopping", name: "Shopping", userId: "alice" }] }],
			})

			// User should have 3 list references
			const userData = getServerData(db, ["users", "alice"])
			const listRefs = userData.filter((d) => d.key[0] === "lists")
			assert.equal(listRefs.length, 3)

			// Each list should exist independently
			assert.ok(getServerData(db, ["todoList", "work"]).length > 0)
			assert.ok(getServerData(db, ["todoList", "home"]).length > 0)
			assert.ok(getServerData(db, ["todoList", "shopping"]).length > 0)
		})

		it("todos maintain order via fractional indexing", () => {
			const { db, api } = server()

			// Setup list
			api.write({
				ops: [{ fn: "createList", args: [{ listId: "list1", name: "Ordered", userId: "alice" }] }],
			})

			// Add todos with specific ordering
			const orderA = generateKeyBetween(null, null)
			const orderB = generateKeyBetween(orderA, null)
			const orderC = generateKeyBetween(orderB, null)

			api.write({
				ops: [
					{
						fn: "addTodo",
						args: [{
							listId: "list1",
							todo: { id: "1", text: "First", checked: false, order: orderA },
						}],
					},
				],
			})
			api.write({
				ops: [
					{
						fn: "addTodo",
						args: [{
							listId: "list1",
							todo: { id: "2", text: "Second", checked: false, order: orderB },
						}],
					},
				],
			})
			api.write({
				ops: [
					{
						fn: "addTodo",
						args: [{
							listId: "list1",
							todo: { id: "3", text: "Third", checked: false, order: orderC },
						}],
					},
				],
			})

			// Get all index (ordered by order)
			const listData = getServerData(db, ["todoList", "list1"])
			const allIndex = listData
				.filter((d) => d.key[0] === "all")
				.sort((a, b) => (a.key[1] as string).localeCompare(b.key[1] as string))

			assert.equal(allIndex.length, 3)
			assert.equal(allIndex[0].key[2], "1") // First
			assert.equal(allIndex[1].key[2], "2") // Second
			assert.equal(allIndex[2].key[2], "3") // Third

			// Insert between first and second
			const orderAB = generateKeyBetween(orderA, orderB)
			api.write({
				ops: [
					{
						fn: "addTodo",
						args: [{
							listId: "list1",
							todo: { id: "1.5", text: "Between 1 and 2", checked: false, order: orderAB },
						}],
					},
				],
			})

			// Check new order
			const listData2 = getServerData(db, ["todoList", "list1"])
			const allIndex2 = listData2
				.filter((d) => d.key[0] === "all")
				.sort((a, b) => (a.key[1] as string).localeCompare(b.key[1] as string))

			assert.equal(allIndex2.length, 4)
			assert.equal(allIndex2[0].key[2], "1")
			assert.equal(allIndex2[1].key[2], "1.5") // Inserted between
			assert.equal(allIndex2[2].key[2], "2")
			assert.equal(allIndex2[3].key[2], "3")
		})

		it("delete list removes from user scope", () => {
			const { db, api } = server()

			// Create list
			api.write({
				ops: [
					{ fn: "createList", args: [{ listId: "list1", name: "To Delete", userId: "alice" }] },
				],
			})

			// Verify user has list reference
			let userData = getServerData(db, ["users", "alice"])
			assert.ok(userData.find((d) => d.key[0] === "listMap" && d.key[1] === "list1"))

			// Delete list
			api.write({
				ops: [{ fn: "deleteList", args: [{ listId: "list1", userId: "alice" }] }],
			})

			// User should no longer have list reference
			userData = getServerData(db, ["users", "alice"])
			assert.ok(!userData.find((d) => d.key[0] === "listMap" && d.key[1] === "list1"))
			assert.ok(!userData.find((d) => d.key[0] === "lists" && d.key[2] === "list1"))
		})
	})
})
