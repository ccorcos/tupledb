import { strict as assert } from "node:assert"
import { describe, it, beforeEach } from "node:test"
import { AppDbClient } from "./AppDbClient"
import { SyncDbClient } from "./SyncDbClient"
import { AppServerApi, PubsubApi } from "./types"
import { Commit, ReducerMap, CommitMeta, CommitArgs } from "../types"
import { TupleDb, Tuple, JSONValue } from "../../tupleDb/types"

// ============================================================================
// Test Reducers
// ============================================================================

type Todo = {
	id: string
	text: string
	checked: boolean
	listId: string
}

const testReducers = {
	setTodo: (tx: TupleDb, _commit: CommitMeta, todo: Todo) => {
		// Write to the specific list's data subspace
		tx.subspace(["todoList", todo.listId]).subspace(["data"]).set(["todo", todo.id], todo)
	},
	deleteTodo: (tx: TupleDb, _commit: CommitMeta, listId: string, todoId: string) => {
		tx.subspace(["todoList", listId]).subspace(["data"]).delete(["todo", todoId])
	},
} satisfies ReducerMap

type TestReducers = typeof testReducers

// ============================================================================
// Mock Server
// ============================================================================

class MockAppServer implements AppServerApi {
	private data = new Map<string, { key: Tuple; value: JSONValue }[]>()
	private commits = new Map<string, Commit[]>()
	private clocks = new Map<string, number>()
	private seen = new Set<string>()

	delay = 0
	shouldFail = false
	failMessage = "Server error"

	async list(
		path: Tuple,
		_range: any
	): Promise<{ clock: number; data: { key: Tuple; value: JSONValue }[] }> {
		if (this.delay) await sleep(this.delay)
		if (this.shouldFail) throw new Error(this.failMessage)
		const key = JSON.stringify(path)
		return {
			clock: this.clocks.get(key) ?? 0,
			data: [...(this.data.get(key) ?? [])],
		}
	}

	async history(
		path: Tuple,
		sinceClock: number
	): Promise<{ clock: number; commits: Commit[] }> {
		if (this.delay) await sleep(this.delay)
		if (this.shouldFail) throw new Error(this.failMessage)
		const key = JSON.stringify(path)
		const allCommits = this.commits.get(key) ?? []
		const commits = allCommits.filter((c) => c.clock > sinceClock)
		return { clock: this.clocks.get(key) ?? 0, commits }
	}

	async write(commit: CommitArgs): Promise<void> {
		if (this.delay) await sleep(this.delay)
		if (this.shouldFail) throw new Error(this.failMessage)

		// Check for duplicate
		if (commit.id && this.seen.has(commit.id)) return
		if (commit.id) this.seen.add(commit.id)

		// Apply each op using the reducers (simplified mock)
		for (const op of commit.ops) {
			if (op.fn === "setTodo") {
				const todo = op.args[0] as Todo
				const scopeKey = JSON.stringify(["todoList", todo.listId])

				// Update clock
				const clock = (this.clocks.get(scopeKey) ?? 0) + 1
				this.clocks.set(scopeKey, clock)

				// Store commit
				const scopeCommits = this.commits.get(scopeKey) ?? []
				scopeCommits.push({
					id: commit.id ?? `commit-${clock}`,
					authorId: commit.authorId,
					createdAt: commit.createdAt,
					clock,
					ops: [op],
				})
				this.commits.set(scopeKey, scopeCommits)

				// Update data
				const scopeData = this.data.get(scopeKey) ?? []
				const index = scopeData.findIndex(
					(d) => d.key[0] === "data" && d.key[1] === "todo" && d.key[2] === todo.id
				)
				const entry = { key: ["data", "todo", todo.id] as Tuple, value: todo }
				if (index >= 0) {
					scopeData[index] = entry
				} else {
					scopeData.push(entry)
				}
				this.data.set(scopeKey, scopeData)
			} else if (op.fn === "deleteTodo") {
				const [listId, todoId] = op.args as [string, string]
				const scopeKey = JSON.stringify(["todoList", listId])

				// Update clock
				const clock = (this.clocks.get(scopeKey) ?? 0) + 1
				this.clocks.set(scopeKey, clock)

				// Store commit
				const scopeCommits = this.commits.get(scopeKey) ?? []
				scopeCommits.push({
					id: commit.id ?? `commit-${clock}`,
					authorId: commit.authorId,
					createdAt: commit.createdAt,
					clock,
					ops: [op],
				})
				this.commits.set(scopeKey, scopeCommits)

				// Update data
				const scopeData = this.data.get(scopeKey) ?? []
				const filtered = scopeData.filter(
					(d) => !(d.key[0] === "data" && d.key[1] === "todo" && d.key[2] === todoId)
				)
				this.data.set(scopeKey, filtered)
			}
		}
	}

	reset() {
		this.data.clear()
		this.commits.clear()
		this.clocks.clear()
		this.seen.clear()
		this.delay = 0
		this.shouldFail = false
	}

	getClock(path: Tuple) {
		return this.clocks.get(JSON.stringify(path)) ?? 0
	}
}

// ============================================================================
// Mock Pubsub
// ============================================================================

class MockPubsub implements PubsubApi {
	private listeners = new Set<(key: string, value: any) => void>()

	subscribe(_key: string) {}
	unsubscribe(_key: string) {}

	onMessage(listener: (key: string, value: any) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	publish(key: string, value: any) {
		for (const listener of this.listeners) {
			listener(key, value)
		}
	}
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function createAppDb(server: MockAppServer, pubsub: MockPubsub): AppDbClient<TestReducers> {
	return new AppDbClient({
		server,
		pubsub,
		reducers: testReducers,
		authorId: "user-1",
	})
}

// ============================================================================
// Tests
// ============================================================================

describe("AppDbClient", () => {
	let server: MockAppServer
	let pubsub: MockPubsub

	beforeEach(() => {
		server = new MockAppServer()
		pubsub = new MockPubsub()
	})

	describe("Initialization", () => {
		it("starts with uninitialized scopes", () => {
			const appDb = createAppDb(server, pubsub)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])

			assert.equal(syncDb.isInitialized(), false)
			assert.equal(syncDb.clock(), 0)
		})

		it("initializes scope and fetches data", async () => {
			const appDb = createAppDb(server, pubsub)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])

			await syncDb.initialize()

			assert.equal(syncDb.isInitialized(), true)
			assert.equal(syncDb.getState().connectionStatus, "connected")
		})

		it("subscribes to pubsub on initialize", async () => {
			const appDb = createAppDb(server, pubsub)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			await syncDb.initialize()

			let stateChanged = false
			syncDb.onStateChange(() => {
				stateChanged = true
			})

			// External commit
			await server.write({
				id: "external-commit",
				ops: [
					{
						fn: "setTodo",
						args: [{ id: "todo-1", text: "External", checked: false, listId: "list-1" }],
					},
				],
			})

			pubsub.publish(
				JSON.stringify(["todoList", "list-1"]),
				server.getClock(["todoList", "list-1"])
			)

			await sleep(10)

			const data = syncDb.list()
			assert.equal(data.length, 1)
			assert.equal(data[0].value.text, "External")
		})
	})

	describe("Commits", () => {
		it("applies commit optimistically and persists after confirmation", async () => {
			const appDb = createAppDb(server, pubsub)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			await syncDb.initialize()

			await appDb.commit([
				{
					fn: "setTodo",
					args: [{ id: "todo-1", text: "Test", checked: false, listId: "list-1" }],
				},
			])

			const data = syncDb.list()
			assert.equal(data.length, 1)
			assert.equal(data[0].value.text, "Test")
			assert.equal(appDb.getPendingCommits().length, 0)
		})

		it("pending commits are visible during submission", async () => {
			const appDb = createAppDb(server, pubsub)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			await syncDb.initialize()

			server.delay = 100

			const commitPromise = appDb.commit([
				{
					fn: "setTodo",
					args: [{ id: "todo-1", text: "Test", checked: false, listId: "list-1" }],
				},
			])

			const pending = appDb.getPendingCommits()
			assert.equal(pending.length, 1)
			assert.equal(pending[0].status, "submitting")

			// Data is visible optimistically
			const data = syncDb.list()
			assert.equal(data.length, 1)

			await commitPromise
			assert.equal(appDb.getPendingCommits().length, 0)
		})

		it("cross-scope commits affect multiple scopes", async () => {
			const appDb = createAppDb(server, pubsub)
			const syncDb1 = appDb.getSyncDb(["todoList", "list-1"])
			const syncDb2 = appDb.getSyncDb(["todoList", "list-2"])

			await syncDb1.initialize()
			await syncDb2.initialize()

			// Commit to two different lists
			await appDb.commit([
				{
					fn: "setTodo",
					args: [{ id: "todo-1", text: "List 1 Todo", checked: false, listId: "list-1" }],
				},
				{
					fn: "setTodo",
					args: [{ id: "todo-2", text: "List 2 Todo", checked: false, listId: "list-2" }],
				},
			])

			assert.equal(syncDb1.list().length, 1)
			assert.equal(syncDb1.list()[0].value.text, "List 1 Todo")

			assert.equal(syncDb2.list().length, 1)
			assert.equal(syncDb2.list()[0].value.text, "List 2 Todo")
		})
	})

	describe("Error Handling", () => {
		it("marks commit as failed on server error", async () => {
			const appDb = createAppDb(server, pubsub)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			await syncDb.initialize()

			server.shouldFail = true
			server.failMessage = "Network error"

			try {
				await appDb.commit([
					{
						fn: "setTodo",
						args: [{ id: "todo-1", text: "Test", checked: false, listId: "list-1" }],
					},
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
			const appDb = createAppDb(server, pubsub)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			await syncDb.initialize()

			server.shouldFail = true

			try {
				await appDb.commit([
					{
						fn: "setTodo",
						args: [{ id: "todo-1", text: "Test", checked: false, listId: "list-1" }],
					},
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
			const appDb = createAppDb(server, pubsub)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			await syncDb.initialize()

			server.shouldFail = true

			try {
				await appDb.commit([
					{
						fn: "setTodo",
						args: [{ id: "todo-1", text: "Test", checked: false, listId: "list-1" }],
					},
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
			const appDb = createAppDb(server, pubsub)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			await syncDb.initialize()

			await appDb.commit([
				{
					fn: "setTodo",
					args: [{ id: "todo-1", text: "Test", checked: false, listId: "list-1" }],
				},
			])

			const data = syncDb.list()
			assert.equal(data.length, 1)
			assert.deepEqual(data[0].key, ["todo", "todo-1"])
		})

		it("can get specific key", async () => {
			const appDb = createAppDb(server, pubsub)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			await syncDb.initialize()

			await appDb.commit([
				{
					fn: "setTodo",
					args: [{ id: "todo-1", text: "Test", checked: false, listId: "list-1" }],
				},
			])

			const value = syncDb.get(["todo", "todo-1"])
			assert.ok(value)
			assert.equal(value.text, "Test")
		})

		it("different scopes are isolated", async () => {
			const appDb = createAppDb(server, pubsub)
			const syncDb1 = appDb.getSyncDb(["todoList", "list-1"])
			const syncDb2 = appDb.getSyncDb(["todoList", "list-2"])

			await syncDb1.initialize()
			await syncDb2.initialize()

			await appDb.commit([
				{
					fn: "setTodo",
					args: [{ id: "todo-1", text: "List 1", checked: false, listId: "list-1" }],
				},
			])

			assert.equal(syncDb1.list().length, 1)
			assert.equal(syncDb2.list().length, 0)
		})
	})

	describe("Subscriptions", () => {
		it("notifies on commit", async () => {
			const appDb = createAppDb(server, pubsub)

			let changeCount = 0
			appDb.onStateChange(() => {
				changeCount++
			})

			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			await syncDb.initialize()

			await appDb.commit([
				{
					fn: "setTodo",
					args: [{ id: "todo-1", text: "Test", checked: false, listId: "list-1" }],
				},
			])

			assert.ok(changeCount > 0)
		})

		it("scope state changes are isolated", async () => {
			const appDb = createAppDb(server, pubsub)
			const syncDb1 = appDb.getSyncDb(["todoList", "list-1"])
			const syncDb2 = appDb.getSyncDb(["todoList", "list-2"])

			let scope1Changes = 0
			let scope2Changes = 0

			syncDb1.onStateChange(() => {
				scope1Changes++
			})
			syncDb2.onStateChange(() => {
				scope2Changes++
			})

			await syncDb1.initialize()

			assert.ok(scope1Changes > 0)
			assert.equal(scope2Changes, 0)
		})
	})

	describe("Dispose", () => {
		it("cleans up on dispose", async () => {
			const appDb = createAppDb(server, pubsub)
			const syncDb = appDb.getSyncDb(["todoList", "list-1"])
			await syncDb.initialize()

			let changeCount = 0
			appDb.onStateChange(() => {
				changeCount++
			})

			appDb.dispose()

			const countAfterDispose = changeCount

			pubsub.publish(JSON.stringify(["todoList", "list-1"]), 99)
			await sleep(10)

			assert.equal(changeCount, countAfterDispose)
		})
	})
})
