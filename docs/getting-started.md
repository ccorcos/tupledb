# Getting Started

## Installation

```bash
npm install
```

## Basic Usage

### In-Memory Database

```typescript
import { tupleDb, tupleTx } from "./src/tupleDb/TupleDb"

const db = tupleDb()

// Basic operations
db.set(["users", 1], { id: 1, name: "Chet" })
db.get(["users", 1])     // { id: 1, name: "Chet" }
db.has(["users", 1])     // true
db.delete(["users", 1])

// Range queries
db.set(["users", 1], { name: "Alice" })
db.set(["users", 2], { name: "Bob" })
db.set(["users", 3], { name: "Charlie" })

db.list({ gte: ["users", 1], lte: ["users", 2] })
// [{ key: ["users", 1], value: {...} }, { key: ["users", 2], value: {...} }]

db.list({ gte: ["users"], lt: ["users", null], limit: 2 })
// First 2 users (null sorts last, so this gets all users)
```

### Subspaces

Subspaces provide transparent namespacing:

```typescript
const users = db.subspace(["users"])
users.set([1], { name: "Chet" })      // Actually ["users", 1]
users.get([1])                         // Works transparently
users.list()                           // Only items under ["users", ...]

const chet = users.subspace([1])
chet.set(["posts", "p1"], { body: "Hello" })  // ["users", 1, "posts", "p1"]
```

### Transactions

```typescript
const tx = tupleTx(db)

tx.set(["counter"], 1)
tx.set(["data", "a"], "value")
tx.get(["counter"])  // 1 (reads pending writes)

tx.commit()  // Writes all changes atomically
```

### Persisted Database (SQLite)

```typescript
import Database from "better-sqlite3"
import { SQLiteOkv } from "./src/tupleDb/SQLiteOkv"
import { tupleOkv, tupleDb } from "./src/tupleDb/TupleDb"

const sqlite = new Database("app.db")
const db = tupleDb(tupleOkv(new SQLiteOkv(sqlite)))

// Use exactly like in-memory
db.set(["config", "theme"], "dark")
```

## RecordDb: Schema and Indexing

RecordDb adds typed schemas with automatic incremental view maintenance.

### Setup

```typescript
import { recordDb } from "./src/recordDb/RecordLayer"

const rdb = recordDb(tupleDb())

// Define types with primary keys
rdb.createType("user", { primary: ["id"] })
rdb.createType("post", { primary: ["id"] })
rdb.createType("follow", { primary: ["fromId", "toId"] })
```

### Writing Records

Records are self-identifying via the `type` field:

```typescript
rdb.set({ type: "user", id: "u1", name: "Chet", age: 30 })
rdb.set({ type: "user", id: "u2", name: "Simon", age: 25 })
rdb.set({ type: "post", id: "p1", authorId: "u1", body: "Hello world" })
rdb.set({ type: "follow", fromId: "u2", toId: "u1", createdAt: "2024-01-01" })
```

### Querying

```typescript
// Get by primary key
rdb.get({ type: "user", id: "u1" })

// Delete
rdb.delete({ type: "user", id: "u1" })

// Query all of a type
const users = rdb.query({
  match: { u: { from: "user" } }
})

// Query with filter
const adults = rdb.query({
  match: { u: { from: "user" } },
  where: { "u.age": { $gte: 18 } }
})

// Query with sort
const byAge = rdb.query({
  match: { u: { from: "user" } },
  sort: ["u.age", "u.id"]
})
```

### Joins

```typescript
// Posts by users I follow
const feed = rdb.query({
  match: {
    f: { from: "follow" },
    p: { from: "post", on: { authorId: "f.toId" } }
  },
  where: { "f.fromId": "u2" },
  sort: ["p.createdAt"],
  reverse: true
})

// Followers of followers
const fof = rdb.query({
  match: {
    a: { from: "follow" },
    b: { from: "follow", on: { fromId: "a.toId" } }
  },
  where: { "a.fromId": "u1" },
  sort: ["b.toId"]
})
```

### Aggregations

```typescript
// Count posts per author
const postCounts = rdb.query({
  match: { p: { from: "post" } },
  reduce: {
    groupBy: ["p.authorId"],
    aggregate: { count: { count: "p.id" } }
  }
})

// Max age by name
const maxAgeByName = rdb.query({
  match: { u: { from: "user" } },
  reduce: {
    groupBy: ["u.name"],
    aggregate: { maxAge: { max: "u.age" } }
  }
})
```

### Auto-Indexing

Indexes are created automatically when you query. The system:

1. Checks if a matching index exists
2. If not, creates one with a canonical name
3. Backfills from existing data
4. Maintains incrementally on writes

```typescript
// First query creates the index
const result1 = rdb.query({
  match: { u: { from: "user" } },
  sort: ["u.name", "u.id"]
})

// Second query reuses it
const result2 = rdb.query({
  match: { u: { from: "user" } },
  sort: ["u.name", "u.id"]
})

// Check if index exists
rdb.hasIndex({
  match: { u: { from: "user" } },
  sort: ["u.name", "u.id"]
})  // Returns index name or false
```

## SyncDb: Replication

SyncDb provides history tracking and clock-based synchronization for replication scenarios.

### Basic Usage

```typescript
import { syncDb } from "./src/syncDb/syncDb"
import { ReducerMap, CommitMeta } from "./src/syncDb/types"

// Define reducers for your data
const todoListReducers = {
  setTodo: (tx: TupleDb, commit: CommitMeta, todo: Todo) => {
    tx.set(["todo", todo.id], todo)
    tx.set(["all", todo.order, todo.id], null)
  },
  deleteTodo: (tx: TupleDb, commit: CommitMeta, todoId: string) => {
    const todo = tx.get(["todo", todoId])
    if (!todo) return
    tx.delete(["todo", todoId])
    tx.delete(["all", todo.order, todoId])
  }
} satisfies ReducerMap

// Create a scoped syncDb
const sdb = syncDb(db.subspace(["todoList", listId]), todoListReducers)

// Apply a commit (increments clock, stores in history, runs reducers)
sdb.apply({
  id: "commit-1",
  authorId: "user-1",
  ops: [{ fn: "setTodo", args: [todo] }]
})

// Read current clock
const clock = sdb.clock()  // 1

// Read history
const commits = sdb.history({ gte: [0] })
// [{ key: [1], value: { id, authorId, clock, ops, ... } }]

// Access data subspace
sdb.data.get(["todo", todoId])
sdb.data.list({ gte: ["all"], lt: ["all", null] })
```

### Multi-Scope Reducers

App-level reducers can fan out to multiple scoped syncDbs for cross-entity consistency:

```typescript
const todoAppReducers = {
  setList: (tx: TupleDb, commit: CommitMeta, list: TodoList) => {
    if (!commit.authorId) throw new Error("You need to be logged in.")
    const userId = commit.authorId

    // Update user's list index (separate clock/history)
    syncDb(tx.subspace(["users", userId]), userReducers).apply({
      ...commit,
      ops: [{ fn: "setList", args: [list] }]
    })

    // Update the list itself (separate clock/history)
    syncDb(tx.subspace(["todoList", list.id]), todoListReducers).apply({
      ...commit,
      ops: [{ fn: "setList", args: [list] }]
    })
  },

  addTodo: (tx: TupleDb, commit: CommitMeta, todo: Todo) => {
    syncDb(tx.subspace(["todoList", todo.listId]), todoListReducers).apply({
      ...commit,
      ops: [{ fn: "setTodo", args: [todo] }]
    })
  }
} satisfies ReducerMap
```

### AppDb

AppDb handles client commits with deduplication and reducer dispatch:

```typescript
import { appDb } from "./src/syncDb/appDb"

const app = appDb(db, todoAppReducers)

// Query data at a scoped path (returns clock for sync)
const { clock, data } = app.list(["users", userId], { gte: ["list"], lt: ["list", null] })

// Write a commit (with automatic deduplication via commit.id)
app.write({
  id: "commit-1",           // Enables idempotent writes
  authorId: "user-1",
  ops: [{ fn: "setList", args: [list] }]
})

// Duplicate writes are ignored
app.write({ id: "commit-1", authorId: "user-1", ops: [...] })  // No-op
```

### SyncServer

SyncServer orchestrates appDb with transactions and pub/sub for server-side sync:

```typescript
import { syncServer } from "./src/syncDb/syncServer"

const server = syncServer(db, pubsub, todoAppReducers)

// Query data (delegates to appDb.list)
const { clock, data } = server.list(["users", userId], range)

// Write commits (wrapped in transaction, publishes changes)
server.write({
  authorId: "user-1",
  ops: [{ fn: "addTodo", args: [todo] }]
})
```

## Cache: Client-Side Optimization

```typescript
import { okvCache } from "./src/tupleDb/OkvCache"
import { codec } from "./src/tupleDb/Codec"

const cache = okvCache<Tuple, JSONValue>(codec.compare)

// Insert server response
cache.insert([{
  args: { gte: ["users"], lt: ["users", null] },
  result: [
    { key: ["users", 1], value: { name: "Alice" } },
    { key: ["users", 2], value: { name: "Bob" } }
  ]
}])

// Query with hit/miss/prefix
const result = cache.list({ gte: ["users"], lt: ["users", null] })

if (result.hit) {
  // Full result available
  console.log(result.hit)
}
if (result.miss) {
  // Need to fetch from server
  const data = await fetchFromServer(args)
  cache.insert([{ args, result: data }])
}
if (result.prefix) {
  // Partial result, may need to fetch more
  console.log("Partial:", result.prefix)
}

// Optimistic writes
const finalize = cache.write({
  set: [{ key: ["users", 3], value: { name: "Charlie" } }]
})

// After server confirms:
cache.insert([{
  args: { gte: ["users", 3], lte: ["users", 3] },
  result: [{ key: ["users", 3], value: { name: "Charlie" } }]
}])
finalize()

// Subscriptions for reactivity
const unsub = cache.subscribe(
  { gte: ["users"], lt: ["users", null] },
  () => {
    console.log("Users changed!")
    const updated = cache.list({ gte: ["users"], lt: ["users", null] })
  }
)
```

## Patterns

### Fan-out Writes

```typescript
function sendMessage(tx: TupleDb, msg: Message) {
  // Store the message
  tx.set(["messages", msg.id], msg)

  // Fan out to recipients' inboxes
  for (const userId of msg.recipients) {
    tx.subspace(["users", userId])
      .set(["inbox", msg.createdAt, msg.id], null)
  }
}

const tx = tupleTx(db)
sendMessage(tx, { id: "m1", recipients: ["u1", "u2"], ... })
tx.commit()
```

### Composite Functions

```typescript
function createUser(db: TupleDb, user: User) {
  db.set(["users", user.id], user)
  db.set(["users_by_email", user.email, user.id], null)
  db.set(["users_by_name", user.name, user.id], null)
}

function deleteUser(db: TupleDb, id: string) {
  const user = db.get(["users", id])
  if (!user) return

  db.delete(["users", id])
  db.delete(["users_by_email", user.email, id])
  db.delete(["users_by_name", user.name, id])
}
```

### Range Queries with Null

Use `null` as the max value for prefix queries:

```typescript
// All users (null sorts last)
db.list({ gte: ["users"], lt: ["users", null] })

// Users starting with "A"
db.list({ gte: ["users", "A"], lt: ["users", "B"] })

// All posts for a user
const userPosts = db.subspace(["users", userId])
userPosts.list({ gte: ["posts"], lt: ["posts", null] })
```

## Running Tests

```bash
# All tests
npm test

# Single file
npx tsx src/tupleDb/TupleDb.test.ts

# Type checking
npm run typecheck
```
