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
		it("starts with uninitialized scopes", () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])

			assert.equal(syncDb.isInitialized(), false)
			assert.equal(syncDb.clock(), 0)
		})

		it("initializes scope and fetches data", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])

			await syncDb.initialize()

			assert.equal(syncDb.isInitialized(), true)
		})

		it("subscribes to pubsub on initialize", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })

			await syncDb.initialize()

			// External commit via server
			await server.write({
				authorId: "other-user",
				ops: [
					{ fn: "setList", args: [list] },
					{ fn: "addTodo", args: [createTodo("list-1", { id: "todo-1", text: "External" })] },
				],
			})

			// Simulate pubsub notification (server would do this in production)
			pubsub.publish(JSON.stringify(["todoList", "list-1"]), 2)

			await sleep(10)

			const todos = getTodos(syncDb)
			assert.equal(todos.length, 1)
			assert.equal(todos[0].text, "External")
		})
	})

	describe("Commits", () => {
		it("applies commit optimistically and persists after confirmation", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.initialize()

			await appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			const todos = getTodos(syncDb)
			assert.equal(todos.length, 1)
			assert.equal(todos[0].text, "Test")
			assert.equal(appDb.getPendingCommits().length, 0)
		})

		it("pending commits are visible during submission", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.initialize()

			server.delay = 100

			const commitPromise = appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			const pending = appDb.getPendingCommits()
			assert.equal(pending.length, 1)
			assert.equal(pending[0].status, "submitting")

			// Data is visible optimistically
			const todos = getTodos(syncDb)
			assert.equal(todos.length, 1)

			await commitPromise
			assert.equal(appDb.getPendingCommits().length, 0)
		})

		it("cross-scope commits affect multiple scopes", async () => {
			const appDb = createAppDb(server, client)
			const syncDb1 = appDb.getSyncDb(["todoList", "list-1"])
			const syncDb2 = appDb.getSyncDb(["todoList", "list-2"])

			await syncDb1.initialize()
			await syncDb2.initialize()

			const list1 = createList({ id: "list-1" })
			const list2 = createList({ id: "list-2" })
			const todo1 = createTodo("list-1", { id: "todo-1", text: "List 1 Todo" })
			const todo2 = createTodo("list-2", { id: "todo-2", text: "List 2 Todo" })

			await appDb.commit([
				{ fn: "setList", args: [list1] },
				{ fn: "setList", args: [list2] },
				{ fn: "addTodo", args: [todo1] },
				{ fn: "addTodo", args: [todo2] },
			])

			const todos1 = getTodos(syncDb1)
			assert.equal(todos1.length, 1)
			assert.equal(todos1[0].text, "List 1 Todo")

			const todos2 = getTodos(syncDb2)
			assert.equal(todos2.length, 1)
			assert.equal(todos2[0].text, "List 2 Todo")
		})
	})

	describe("Error Handling", () => {
		it("marks commit as failed on server error", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.initialize()

			server.shouldFail = true
			server.failMessage = "Network error"

			try {
				await appDb.commit([
					{ fn: "setList", args: [list] },
					{ fn: "addTodo", args: [todo] },
				])
				assert.fail("Should have thrown")
			} catch (e) {
				assert.ok(e instanceof Error)
				assert.equal(e.message, "Network error")
			}

			const pending = appDb.getPendingCommits()
			assert.equal(pending.length, 1)
			assert.equal(pending[0].status, "failed")
			assert.equal(pending[0].error, "Network error")
		})

		it("can retry failed commits", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.initialize()

			server.shouldFail = true

			try {
				await appDb.commit([
					{ fn: "setList", args: [list] },
					{ fn: "addTodo", args: [todo] },
				])
			} catch {
				// Expected
			}

			const pending = appDb.getPendingCommits()[0]
			server.shouldFail = false

			await appDb.retryCommit(pending.id)
			assert.equal(appDb.getPendingCommits().length, 0)
		})

		it("can cancel failed commits", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.initialize()

			server.shouldFail = true

			try {
				await appDb.commit([
					{ fn: "setList", args: [list] },
					{ fn: "addTodo", args: [todo] },
				])
			} catch {
				// Expected
			}

			const pending = appDb.getPendingCommits()[0]
			appDb.cancelCommit(pending.id)

			assert.equal(appDb.getPendingCommits().length, 0)
			assert.equal(syncDb.list().length, 0)
		})
	})

	describe("SyncDbClient", () => {
		it("provides scoped view of data", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.initialize()

			await appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			const todos = getTodos(syncDb)
			assert.equal(todos.length, 1)
			assert.equal(todos[0].id, "todo-1")
		})

		it("can get specific key", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.initialize()

			await appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			const value = syncDb.get(["todo", "todo-1"])
			assert.ok(value)
			assert.equal(value.text, "Test")
		})

		it("different scopes are isolated", async () => {
			const appDb = createAppDb(server, client)
			const syncDb1 = appDb.getSyncDb(["todoList", "list-1"])
			const syncDb2 = appDb.getSyncDb(["todoList", "list-2"])

			await syncDb1.initialize()
			await syncDb2.initialize()

			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "List 1" })

			await appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			assert.equal(getTodos(syncDb1).length, 1)
			assert.equal(getTodos(syncDb2).length, 0)
		})
	})

	describe("Subscriptions", () => {
		it("notifies on commit", async () => {
			const appDb = createAppDb(server, client)

			let changeCount = 0
			appDb.onStateChange(() => {
				changeCount++
			})

			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "Test" })

			await syncDb.initialize()

			await appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			assert.ok(changeCount > 0)
		})

		it("data subscriptions notify on data changes", async () => {
			const appDb = createAppDb(server, client)
			const syncDb1 = appDb.getSyncDb(["todoList", "list-1"])

			let changeCount = 0
			syncDb1.subscribe({}, () => {
				changeCount++
			})

			await syncDb1.initialize()

			const list = createList({ id: "list-1" })
			const todo = createTodo("list-1", { id: "todo-1", text: "List 1 Todo" })

			await appDb.commit([
				{ fn: "setList", args: [list] },
				{ fn: "addTodo", args: [todo] },
			])

			assert.ok(changeCount > 0)
		})
	})

	describe("Dispose", () => {
		it("cleans up on dispose", async () => {
			const appDb = createAppDb(server, client)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			await syncDb.initialize()

			let changeCount = 0
			appDb.onStateChange(() => {
				changeCount++
			})

			appDb.dispose()

			const countAfterDispose = changeCount

			// This should not trigger our listener since we disposed
			pubsub.publish(JSON.stringify(["todoList", "list-1"]), 99)
			await sleep(10)

			assert.equal(changeCount, countAfterDispose)
		})
	})
})
