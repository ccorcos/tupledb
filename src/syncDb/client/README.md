# SyncDb Client

The SyncDb client provides real-time synchronization between browser clients and a server. It supports optimistic updates, automatic conflict resolution via server clock ordering, and subscription-based reactivity.

## Core Concepts

- **AppDbClient** - The main client that manages server communication, caching, and pending commits
- **SyncDbClient** - A scoped view into a specific path in the database (e.g., a single todo list)
- **Reducers** - Functions that define how operations modify data
- **Commits** - Batches of operations sent to the server

## Setup

### Define Reducers

Reducers describe how operations modify the database. They run both on the client (for optimistic updates) and server (for persistence).

```typescript
import { TupleDb } from "tupledb/tupleDb/types"
import { CommitMeta, ReducerMap } from "tupledb/syncDb/types"

type Todo = { id: string; text: string; done: boolean }

const todoReducers = {
  addTodo: (tx: TupleDb, commit: CommitMeta, todo: Todo) => {
    tx.set(["todo", todo.id], todo)
  },

  toggleTodo: (tx: TupleDb, commit: CommitMeta, todoId: string) => {
    const todo = tx.get(["todo", todoId]) as Todo
    if (todo) {
      tx.set(["todo", todoId], { ...todo, done: !todo.done })
    }
  },

  deleteTodo: (tx: TupleDb, commit: CommitMeta, todoId: string) => {
    tx.delete(["todo", todoId])
  },
} satisfies ReducerMap
```

### Implement Server API

The client needs an object implementing `AppServerApi` to communicate with your server:

```typescript
import { AppServerApi } from "tupledb/syncDb/client/types"

const server: AppServerApi = {
  async list(path, range) {
    const res = await fetch(`/api/list?path=${JSON.stringify(path)}&range=${JSON.stringify(range)}`)
    return res.json() // { clock: number, data: { key, value }[] }
  },

  async history(path, sinceClock) {
    const res = await fetch(`/api/history?path=${JSON.stringify(path)}&since=${sinceClock}`)
    return res.json() // { clock: number, commits: Commit[] }
  },

  async write(commit) {
    await fetch("/api/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(commit),
    })
  },
}
```

### Implement Pubsub API

The client needs a pubsub connection for real-time updates. This could be WebSocket, SSE, or any push mechanism:

```typescript
import { PubsubApi } from "tupledb/syncDb/client/types"

function createWebSocketPubsub(url: string): PubsubApi {
  const ws = new WebSocket(url)
  const listeners = new Set<(key: string, value: any) => void>()
  const subscribed = new Set<string>()

  ws.onmessage = (event) => {
    const { key, value } = JSON.parse(event.data)
    for (const listener of listeners) {
      listener(key, value)
    }
  }

  return {
    subscribe(key) {
      subscribed.add(key)
      ws.send(JSON.stringify({ type: "subscribe", key }))
    },
    unsubscribe(key) {
      subscribed.delete(key)
      ws.send(JSON.stringify({ type: "unsubscribe", key }))
    },
    onMessage(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

## Browser Usage (Vanilla JS)

### Initialize the Client

```typescript
import { AppDbClient } from "tupledb/syncDb/client/AppDbClient"

const appDb = new AppDbClient({
  server,
  pubsub: createWebSocketPubsub("wss://example.com/pubsub"),
  reducers: todoReducers,
  authorId: "user-123", // optional, for tracking who made changes
})
```

### Access a Scope

A `SyncDbClient` provides access to a specific path in the database:

```typescript
const listId = "list-abc"
const syncDb = appDb.getSyncDb(["todoList", listId])

// Initialize fetches data from server and subscribes to updates
await syncDb.initialize()
```

### Read Data

```typescript
// List all data in scope
const items = syncDb.list()
// [{ key: ["todo", "1"], value: { id: "1", text: "...", done: false } }, ...]

// Get a specific key
const todo = syncDb.get(["todo", "1"])

// Range queries
const todos = syncDb.list({ gte: ["todo"], lte: ["todo", []] })
```

### Write Data

Commits are applied optimistically then synced to the server:

```typescript
appDb.commit([
  { fn: "addTodo", args: [{ id: "new-1", text: "Buy milk", done: false }] },
])

// Multiple operations in one commit
appDb.commit([
  { fn: "toggleTodo", args: ["todo-1"] },
  { fn: "deleteTodo", args: ["todo-2"] },
])
```

### Subscribe to Changes

```typescript
// Subscribe to all changes in scope
const unsubscribe = syncDb.subscribe({}, () => {
  console.log("Data changed:", syncDb.list())
  render()
})

// Subscribe to specific range
syncDb.subscribe({ gte: ["todo"], lte: ["todo", []] }, () => {
  console.log("Todos changed")
})

// Unsubscribe when done
unsubscribe()
```

### Track Pending Commits

```typescript
// Get pending commits
const pending = appDb.getPendingCommits()
// [{ id, status: "pending" | "submitting" | "failed", error?, ops, ... }]

// Listen to state changes (pending status, etc.)
const unsubscribe = appDb.onStateChange(() => {
  const pending = appDb.getPendingCommits()
  if (pending.some((c) => c.status === "failed")) {
    showErrorUI(pending.filter((c) => c.status === "failed"))
  }
})
```

### Handle Failures

```typescript
const pending = appDb.getPendingCommits()
const failed = pending.find((c) => c.status === "failed")

if (failed) {
  // Retry the failed commit
  appDb.retryCommit(failed.id)

  // Or cancel it (reverts the optimistic update)
  appDb.cancelCommit(failed.id)
}
```

### Cleanup

```typescript
// Dispose when done (e.g., on page unload)
appDb.dispose()
```

## React Usage

### Create a Provider

First, create a context provider for the `AppDbClient`:

```tsx
// SyncDbProvider.tsx
import { createContext, useContext, ReactNode } from "react"
import { AppDbClient } from "tupledb/syncDb/client/AppDbClient"
import { ReducerMap } from "tupledb/syncDb/types"

const AppDbContext = createContext<AppDbClient | null>(null)

export function useAppDb<R extends ReducerMap>(): AppDbClient<R> {
  const appDb = useContext(AppDbContext)
  if (!appDb) throw new Error("useAppDb must be used within SyncDbProvider")
  return appDb as AppDbClient<R>
}

type Props<R extends ReducerMap> = {
  appDb: AppDbClient<R>
  children: ReactNode
}

export function SyncDbProvider<R extends ReducerMap>({ appDb, children }: Props<R>) {
  return <AppDbContext.Provider value={appDb}>{children}</AppDbContext.Provider>
}
```

### Set Up the App

```tsx
// App.tsx
import { AppDbClient } from "tupledb/syncDb/client/AppDbClient"
import { SyncDbProvider } from "./SyncDbProvider"

const appDb = new AppDbClient({
  server,
  pubsub: createWebSocketPubsub("wss://example.com/pubsub"),
  reducers: todoReducers,
  authorId: currentUser.id,
})

function App() {
  return (
    <SyncDbProvider appDb={appDb}>
      <TodoList listId="list-abc" />
    </SyncDbProvider>
  )
}
```

### Use the Hooks

#### useSyncDb

Manages a scoped view and handles initialization:

```tsx
import { useSyncDb } from "tupledb/syncDb/client/react/useSyncDb"

function TodoList({ listId }: { listId: string }) {
  const { syncDb, isInitialized, clock } = useSyncDb(["todoList", listId])

  if (!isInitialized) {
    return <div>Loading...</div>
  }

  const todos = syncDb.list({ gte: ["todo"], lte: ["todo", []] })

  return (
    <ul>
      {todos.map(({ key, value }) => (
        <TodoItem key={key.join("/")} todo={value} />
      ))}
    </ul>
  )
}
```

#### useList

Reactive list with automatic re-rendering on data changes:

```tsx
import { useList } from "tupledb/syncDb/client/react/useList"

function TodoList({ listId }: { listId: string }) {
  const { syncDb, isInitialized } = useSyncDb(["todoList", listId])
  const { local, isLoading, error } = useList(syncDb, { gte: ["todo"], lte: ["todo", []] })

  if (!isInitialized || isLoading) {
    return <div>Loading...</div>
  }

  return (
    <ul>
      {local.map(({ key, value }) => (
        <TodoItem key={key.join("/")} todo={value} />
      ))}
    </ul>
  )
}
```

#### useCommit

Commit operations with loading and error state:

```tsx
import { useCommit } from "tupledb/syncDb/client/react/useCommit"

function AddTodoForm({ listId }: { listId: string }) {
  const { commit, isSubmitting, error, clearError } = useCommit()
  const [text, setText] = useState("")

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    await commit([
      { fn: "addTodo", args: [{ id: crypto.randomUUID(), text, done: false }] },
    ])
    setText("")
  }

  return (
    <form onSubmit={handleSubmit}>
      <input value={text} onChange={(e) => setText(e.target.value)} />
      <button disabled={isSubmitting}>Add</button>
      {error && <span onClick={clearError}>{error.message}</span>}
    </form>
  )
}
```

#### usePending

Track pending commit status:

```tsx
import { usePending } from "tupledb/syncDb/client/react/usePending"
import { useCommit } from "tupledb/syncDb/client/react/useCommit"

function SyncStatus() {
  const { hasPending, hasFailed, pendingIds } = usePending()
  const { retry, cancel } = useCommit()

  if (hasFailed) {
    return (
      <div>
        Sync failed
        <button onClick={() => pendingIds.forEach(retry)}>Retry</button>
        <button onClick={() => pendingIds.forEach(cancel)}>Discard</button>
      </div>
    )
  }

  if (hasPending) {
    return <div>Syncing...</div>
  }

  return <div>Synced</div>
}
```

### Complete Example

```tsx
import { useState, FormEvent } from "react"
import { AppDbClient } from "tupledb/syncDb/client/AppDbClient"
import { useSyncDb } from "tupledb/syncDb/client/react/useSyncDb"
import { useList } from "tupledb/syncDb/client/react/useList"
import { useCommit } from "tupledb/syncDb/client/react/useCommit"
import { usePending } from "tupledb/syncDb/client/react/usePending"
import { SyncDbProvider, useAppDb } from "./SyncDbProvider"

type Todo = { id: string; text: string; done: boolean }

function TodoApp({ listId }: { listId: string }) {
  const { syncDb, isInitialized } = useSyncDb(["todoList", listId])
  const { local: todos } = useList(syncDb, { gte: ["todo"], lte: ["todo", []] })
  const { commit } = useCommit()
  const { hasPending, hasFailed } = usePending()
  const [text, setText] = useState("")

  if (!isInitialized) return <div>Loading...</div>

  const addTodo = (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    commit([{ fn: "addTodo", args: [{ id: crypto.randomUUID(), text, done: false }] }])
    setText("")
  }

  const toggle = (id: string) => {
    commit([{ fn: "toggleTodo", args: [id] }])
  }

  const remove = (id: string) => {
    commit([{ fn: "deleteTodo", args: [id] }])
  }

  return (
    <div>
      <form onSubmit={addTodo}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="New todo" />
        <button>Add</button>
      </form>

      <ul>
        {todos.map(({ value: todo }) => (
          <li key={todo.id}>
            <input type="checkbox" checked={todo.done} onChange={() => toggle(todo.id)} />
            <span style={{ textDecoration: todo.done ? "line-through" : "none" }}>{todo.text}</span>
            <button onClick={() => remove(todo.id)}>Delete</button>
          </li>
        ))}
      </ul>

      <div>{hasFailed ? "Sync error" : hasPending ? "Syncing..." : "Synced"}</div>
    </div>
  )
}

// Usage
const appDb = new AppDbClient({ server, pubsub, reducers: todoReducers })

function App() {
  return (
    <SyncDbProvider appDb={appDb}>
      <TodoApp listId="my-list" />
    </SyncDbProvider>
  )
}
```

## API Reference

### AppDbClient

| Method | Description |
|--------|-------------|
| `getSyncDb(path)` | Get a scoped SyncDbClient for a path |
| `commit(ops)` | Apply operations optimistically and sync to server |
| `getPendingCommits()` | Get list of pending/failed commits |
| `retryCommit(id)` | Retry a failed commit |
| `cancelCommit(id)` | Cancel a failed commit, reverting optimistic state |
| `flush()` | Wait for all pending commits to complete |
| `onStateChange(fn)` | Subscribe to state changes (returns unsubscribe fn) |
| `dispose()` | Clean up subscriptions |

### SyncDbClient

| Method | Description |
|--------|-------------|
| `initialize()` | Fetch initial data and subscribe to updates |
| `isInitialized()` | Check if scope has been initialized |
| `clock()` | Get current server clock for scope |
| `list(args?)` | List data with optional range query |
| `get(key)` | Get a specific key |
| `subscribe(range, fn)` | Subscribe to data changes in range |
| `sync()` | Manually trigger sync with server |
| `history(range?)` | Get commit history |
| `data(prefix?)` | Get a subspace data view |

### React Hooks

| Hook | Returns | Description |
|------|---------|-------------|
| `useSyncDb(path)` | `{ syncDb, isInitialized, clock }` | Manage a scoped SyncDbClient |
| `useList(source, args?)` | `{ local, remote, isLoading, error }` | Reactive list with loading state |
| `useCommit(appDb?)` | `{ commit, isSubmitting, error, clearError, retry, cancel }` | Commit operations |
| `usePending(appDb?)` | `{ pendingIds, hasPending, hasFailed }` | Track pending commits |
