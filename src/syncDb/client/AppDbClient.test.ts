import { strict as assert } from "node:assert"
import { beforeEach, describe, it } from "node:test"
import { PubsubHarness, PubsubHarnessClient } from "../../fixtures/PubsubHarness"
import { randomId } from "../../shared/randomId"
import { tupleDb } from "../../tupleDb/TupleDb"
import { Tuple, TupleDb } from "../../tupleDb/types"
import { Todo, TodoList, todoAppReducers } from "../examples/TodoMVC"
import { syncServer } from "../syncServer"
import { Commit } from "../types"
import { AppDbClient } from "./AppDbClient"
import { AppServerApi } from "./types"

// ============================================================================
// Test Helpers
// ============================================================================

function createList(overrides: Partial<TodoList> = {}): TodoList {
	return {
		id: randomId(),
		name: "My List",
		editedAt: new Date().toISOString(),
		...overrides,
	}
}

function createTodo(listId: string, overrides: Partial<Todo> = {}): Todo {
	return {
		id: randomId(),
		listId,
		text: "Do something",
		checked: false,
		order: "a",
		...overrides,
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Get just the todos from a syncDb (filters out indexes) */
function getTodos(syncDb: { list: () => { key: Tuple; value: any }[] }): Todo[] {
	return syncDb
		.list()
		.filter((d) => d.key[0] === "todo")
		.map((d) => d.value as Todo)
}

// ============================================================================
// Mock Server - wraps real syncServer with delay/failure simulation
// ============================================================================

class MockAppServer implements AppServerApi {
	private db: TupleDb
	private server: ReturnType<typeof syncServer>

	delay = 0
	shouldFail = false
	failMessage = "Server error"

	constructor(pubsub: PubsubHarness) {
		this.db = tupleDb()
		this.server = syncServer(this.db, pubsub, todoAppReducers)
	}

	async list(
		path: Tuple,
		range: any
	): Promise<{ clock: number; data: { key: Tuple; value: any }[] }> {
		if (this.delay) await sleep(this.delay)
		if (this.shouldFail) throw new Error(this.failMessage)
		const result = this.server.list(path, range)
		return { clock: result.clock ?? 0, data: result.data }
	}

	async history(
		path: Tuple,
		sinceClock: number
	): Promise<{ clock: number; commits: Commit[] }> {
		if (this.delay) await sleep(this.delay)
		if (this.shouldFail) throw new Error(this.failMessage)
		const result = this.server.list(path, {
			gte: ["history"],
			lte: ["history", []],
		})
		const commits = result.data
			.map(({ value }) => value as Commit)
			.filter((c) => c.clock > sinceClock)
		return { clock: result.clock ?? 0, commits }
	}

	async write(commit: any): Promise<void> {
		if (this.delay) await sleep(this.delay)
		if (this.shouldFail) throw new Error(this.failMessage)
		this.server.write(commit)
	}

	reset() {
		this.delay = 0
		this.shouldFail = false
	}
}

// ============================================================================
// Test Setup
// ============================================================================

type TestReducers = typeof todoAppReducers

function createTestHarness() {
	const pubsub = new PubsubHarness()
	const server = new MockAppServer(pubsub)
	const client = pubsub.client()
	return { pubsub, server, client }
}

function createAppDb(
	server: MockAppServer,
	client: PubsubHarnessClient
): AppDbClient<TestReducers> {
	return new AppDbClient({
		server,
		pubsub: client,
		reducers: todoAppReducers,
		authorId: "user-1",
	})
}

// ============================================================================
// Tests
// ============================================================================

describe("AppDbClient", () => {
	let pubsub: PubsubHarness
	let server: MockAppServer
	let client: PubsubHarnessClient

	beforeEach(() => {
		const harness = createTestHarness()
		pubsub = harness.pubsub
		server = harness.server
		client = harness.client
	})

	describe("Initialization", () => {
		it("starts with empty data before sync completes", () => {
			server.delay = 100
			const appDb = createAppDb(server, client)
			const syncDb = appDb.syncDb(["todoList", "list-1"])

			assert.equal(syncDb.clock(), 0)
			assert.deepEqual(syncDb.list(), [])
			syncDb.destroy()
		})

		it("implicitly initializes scope on getSyncDb", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.syncDb(["todoList", "list-1"])

			await syncDb.sync()

			assert.equal(syncDb.clock() >= 0, true)
			syncDb.destroy()
		})

		it("subscribes to pubsub on getSyncDb", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.syncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })

			await syncDb.sync()

			// External commit via server (publishes to pubsub automatically)
			await server.write({
				authorId: "other-user",
				ops: [
					{ fn: "setList", args: [list] },
					{ fn: "addTodo", args: [createTodo("list-1", { id: "todo-1", text: "External" })] },
				],
			})

			await sleep(10)

			const todos = getTodos(syncDb)
			assert.equal(todos.length, 1)
			assert.equal(todos[0].text, "External")
			syncDb.destroy()
		})
	})

	describe("Reference Counting", () => {
		it("increments ref count on getSyncDb", async () => {
			const appDb = createAppDb(server, client)
			const syncDb1 = appDb.syncDb(["todoList", "list-1"])
			const syncDb2 = appDb.syncDb(["todoList", "list-1"])

			await syncDb1.sync()

			// Both syncDbs should work
			assert.equal(syncDb1.clock(), syncDb2.clock())

			syncDb1.destroy()
			syncDb2.destroy()
		})

		it("unsubscribes from pubsub when all refs destroyed", async () => {
			const appDb = createAppDb(server, client)
			const syncDb1 = appDb.syncDb(["todoList", "list-1"])
			const syncDb2 = appDb.syncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })

			await syncDb1.sync()

			syncDb1.destroy()

			// syncDb2 should still receive updates
			await server.write({
				authorId: "other-user",
				ops: [
					{ fn: "setList", args: [list] },
					{ fn: "addTodo", args: [createTodo("list-1", { id: "todo-1", text: "Test" })] },
				],
			})
			await sleep(10)
			assert.equal(getTodos(syncDb2).length, 1)

			syncDb2.destroy()

			// After both destroyed, pubsub should be unsubscribed
			// Creating a new syncDb should work fresh
			const syncDb3 = appDb.syncDb(["todoList", "list-1"])
			await syncDb3.sync()
			assert.equal(getTodos(syncDb3).length, 1)
			syncDb3.destroy()
		})
	})

	describe("Commits", () => {
		it("applies commit optimistically and persists after confirmation", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.syncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.sync()

			appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			// Data is visible optimistically immediately
			const todos = getTodos(syncDb)
			assert.equal(todos.length, 1)
			assert.equal(todos[0].text, "Test")

			// Wait for server confirmation
			await appDb.flush()
			assert.equal(appDb.getPendingCommits().length, 0)
			syncDb.destroy()
		})

		it("pending commits are visible during submission", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.syncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.sync()

			server.delay = 100

			appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			// Give time for status to transition to submitting
			await sleep(5)

			const pending = appDb.getPendingCommits()
			assert.equal(pending.length, 1)
			assert.equal(pending[0].status, "submitting")

			// Data is visible optimistically
			const todos = getTodos(syncDb)
			assert.equal(todos.length, 1)

			await appDb.flush()
			assert.equal(appDb.getPendingCommits().length, 0)
			syncDb.destroy()
		})

		it("cross-scope commits affect multiple scopes", async () => {
			const appDb = createAppDb(server, client)
			const syncDb1 = appDb.syncDb(["todoList", "list-1"])
			const syncDb2 = appDb.syncDb(["todoList", "list-2"])

			await syncDb1.sync()
			await syncDb2.sync()

			const list1 = createList({ id: "list-1" })
			const list2 = createList({ id: "list-2" })
			const todo1 = createTodo("list-1", { id: "todo-1", text: "List 1 Todo" })
			const todo2 = createTodo("list-2", { id: "todo-2", text: "List 2 Todo" })

			appDb.commit([
				{ fn: "setList", args: [list1] },
				{ fn: "setList", args: [list2] },
				{ fn: "addTodo", args: [todo1] },
				{ fn: "addTodo", args: [todo2] },
			])

			// Data is visible optimistically immediately
			const todos1 = getTodos(syncDb1)
			assert.equal(todos1.length, 1)
			assert.equal(todos1[0].text, "List 1 Todo")

			const todos2 = getTodos(syncDb2)
			assert.equal(todos2.length, 1)
			assert.equal(todos2[0].text, "List 2 Todo")

			await appDb.flush()
			syncDb1.destroy()
			syncDb2.destroy()
		})
	})

	describe("Error Handling", () => {
		it("marks commit as failed on server error", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.syncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.sync()

			server.shouldFail = true
			server.failMessage = "Network error"

			appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			// Wait for background sync to fail
			await appDb.flush()

			const pending = appDb.getPendingCommits()
			assert.equal(pending.length, 1)
			assert.equal(pending[0].status, "failed")
			assert.equal(pending[0].error, "Network error")
			syncDb.destroy()
		})

		it("can retry failed commits", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.syncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.sync()

			server.shouldFail = true

			appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			await appDb.flush()

			const pending = appDb.getPendingCommits()[0]
			server.shouldFail = false

			appDb.retryCommit(pending.id)
			await appDb.flush()
			assert.equal(appDb.getPendingCommits().length, 0)
			syncDb.destroy()
		})

		it("can cancel failed commits", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.syncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.sync()

			server.shouldFail = true

			appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			await appDb.flush()

			const pending = appDb.getPendingCommits()[0]
			appDb.cancelCommit(pending.id)

			assert.equal(appDb.getPendingCommits().length, 0)
			assert.equal(syncDb.list().length, 0)
			syncDb.destroy()
		})
	})

	describe("SyncDb", () => {
		it("provides scoped view of data", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.syncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.sync()

			appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			const todos = getTodos(syncDb)
			assert.equal(todos.length, 1)
			assert.equal(todos[0].id, "todo-1")

			await appDb.flush()
			syncDb.destroy()
		})

		it("can get specific key", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.syncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.sync()

			appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			const value = syncDb.get(["todo", "todo-1"])
			assert.ok(value)
			assert.equal(value.text, "Test")

			await appDb.flush()
			syncDb.destroy()
		})

		it("different scopes are isolated", async () => {
			const appDb = createAppDb(server, client)
			const syncDb1 = appDb.syncDb(["todoList", "list-1"])
			const syncDb2 = appDb.syncDb(["todoList", "list-2"])

			await syncDb1.sync()
			await syncDb2.sync()

			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "List 1" })

			appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			assert.equal(getTodos(syncDb1).length, 1)
			assert.equal(getTodos(syncDb2).length, 0)

			await appDb.flush()
			syncDb1.destroy()
			syncDb2.destroy()
		})

		it("subspace provides nested view", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.syncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.sync()

			appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			const todoSubspace = syncDb.subspace(["todo"])
			const todos = todoSubspace.list()
			assert.equal(todos.length, 1)
			assert.equal(todos[0].key[0], "todo-1")

			const value = todoSubspace.get(["todo-1"])
			assert.ok(value)
			assert.equal(value.text, "Test")

			await appDb.flush()
			syncDb.destroy()
		})
	})

	describe("Subscriptions", () => {
		it("notifies on commit", async () => {
			const appDb = createAppDb(server, client)

			let changeCount = 0
			appDb.onStateChange(() => {
				changeCount++
			})

			const syncDb = appDb.syncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.sync()

			appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			assert.ok(changeCount > 0)

			await appDb.flush()
			syncDb.destroy()
		})

		it("data subscriptions notify on data changes", async () => {
			const appDb = createAppDb(server, client)
			const syncDb1 = appDb.syncDb(["todoList", "list-1"])

			let changeCount = 0
			syncDb1.subscribe({}, () => {
				changeCount++
			})

			await syncDb1.sync()

			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "List 1 Todo" })

			appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			assert.ok(changeCount > 0)

			await appDb.flush()
			syncDb1.destroy()
		})
	})

	describe("Dispose", () => {
		it("cleans up on dispose", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.syncDb(["todoList", "list-1"])
			await syncDb.sync()

			let changeCount = 0
			appDb.onStateChange(() => {
				changeCount++
			})

			appDb.dispose()

			const countAfterDispose = changeCount

			// This should not trigger our listener since we disposed
			const list = createList({ id: "list-1" })
			await server.write({
				authorId: "other-user",
				ops: [
					{ fn: "setList", args: [list] },
					{ fn: "addTodo", args: [createTodo("list-1", { id: "todo-1", text: "After dispose" })] },
				],
			})
			await sleep(10)

			assert.equal(changeCount, countAfterDispose)
		})
	})
})
