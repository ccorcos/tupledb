# Architecture

TupleDB is built as a stack of composable layers, each implementing or extending the core `Okv<K, V>` interface.

## Layer Stack

```
┌─────────────────────────────────────────────────────────┐
│                    Application Layer                     │
│   RecordDb (IVM)  |  SyncDb (syncDb, appDb, syncServer) │
├─────────────────────────────────────────────────────────┤
│                      Sugar Layer                         │
│    TupleDb (get, set, delete, has, subspace)            │
├─────────────────────────────────────────────────────────┤
│                    Encoding Layer                        │
│   KeyEncodeOKV | ValueEncodeOKV | TupleSubspaceEncoder  │
├─────────────────────────────────────────────────────────┤
│                    Storage Layer                         │
│           InMemoryOkv  |  SQLiteOkv                     │
└─────────────────────────────────────────────────────────┘
```

## Core Abstraction: Okv<K, V>

Everything revolves around this minimal interface:

```typescript
type Okv<K, V> = {
  compare: (a: K, b: K) => number
  list(args?: ListArgs<K>): { key: K; value: V }[]
  write: (tx: WriteArgs<K, V>) => void
}

type ListArgs<K> = {
  gt?: K; gte?: K; lt?: K; lte?: K  // Range bounds
  limit?: number
  reverse?: boolean
}

type WriteArgs<K, V> = {
  set?: { key: K; value: V }[]
  delete?: K[]
}
```

The `compare` function is critical - it enables building intermediate caching mechanisms and ensures consistent ordering across layers.

## Storage Layer

### InMemoryOkv

Uses a sorted array (`OrderedList` wrapping `@ccorcos/ordered-array`) for O(log n) operations:

```typescript
const db = new InMemoryOkv<string, any>(stringCompare)
db.write({ set: [{ key: "a", value: 1 }] })
db.list({ gte: "a", lt: "b" })
```

Best for:
- Browser/client-side usage
- Testing
- Caching layers

### SQLiteOkv

Persists to SQLite via `better-sqlite3`:

```typescript
const sqlite = new Database("app.db")
const db = new SQLiteOkv(sqlite)
```

Best for:
- Server-side persistence
- Large datasets
- Durability requirements

## Encoding Layer

Transforms keys and values between representations.

### Codec (`src/tupleDb/Codec.ts`)

Encodes tuples into lexicographically ordered strings:

```typescript
codec.encode(["users", 1])  // "[\"users\"#1"
codec.decode("[\"users\"#1") // ["users", 1]
codec.compare(["a", 1], ["a", 2]) // -1
```

Type prefixes ensure correct ordering:
- `?` - Boolean
- `"` - String
- `#` - Number
- `[` - Array
- `{` - Object
- `\xff` - Null (sorts last, useful for prefix queries)

### Encoder Wrappers

```typescript
// Wrap key encoding
function KeyEncodeOKV<I, O, V>(db: Okv<O, V>, encoder: KeyEncoder<I, O>): Okv<I, V>

// Wrap value encoding
function ValueEncodeOKV<K, I, O>(db: Okv<K, O>, encoder: Encoder<I, O>): Okv<K, I>
```

### Subspaces

Transparent prefix-based namespacing:

```typescript
const users = subspace(db, ["users"])
users.set([1], { name: "Chet" })  // Actually writes ["users", 1]
users.list()  // Only returns items under ["users", ...]
```

## Sugar Layer: TupleDb

Adds user-friendly methods on top of `Okv`:

```typescript
const db = tupleDb()

db.set(["users", 1], { name: "Chet" })
db.get(["users", 1])  // { name: "Chet" }
db.has(["users", 1])  // true
db.delete(["users", 1])
db.list({ gte: ["users"], lt: ["users", null] })

const users = db.subspace(["users"])
users.set([2], { name: "Simon" })
```

## Transaction Layer

Buffers writes in an `InMemoryOkv` overlay before committing:

```typescript
const tx = tupleTx(db)
tx.set(["a"], 1)
tx.set(["b"], 2)
tx.get(["a"])  // 1 (reads from pending)
tx.commit()    // Writes to underlying db
```

Key implementation details:
- Tracks both pending `set` and `delete` operations
- "Overfetch" logic: when reading with a limit, fetches extra to account for pending deletes
- Single-commit guarantee prevents double commits

## Cache Layer: OkvCache

Client-side cache with optimistic writes and partial reads:

```typescript
const cache = okvCache<Tuple, JSONValue>(compare)

// Insert server data
cache.insert([{ args: { gte, lt }, result: items }])

// Query with hit/miss/prefix semantics
const result = cache.list({ gte, lt })
if (result.hit) { /* Full result available */ }
if (result.miss) { /* Need to fetch from server */ }
if (result.prefix) { /* Partial result, may need more */ }

// Optimistic write (returns finalizer)
const finalize = cache.write({ set: [{ key, value }] })
// After server confirms:
finalize()

// Reactive subscriptions
cache.subscribe({ gte, lt }, () => { /* Called on changes */ })
```

## RecordDb Layer (IVM)

Schema-based layer with incremental view maintenance:

```typescript
const rdb = recordDb(tupleDb())

// Define types
rdb.createType("user", { primary: ["id"] })
rdb.createType("post", { primary: ["id"] })

// Write records
rdb.set({ type: "user", id: "1", name: "Chet" })
rdb.set({ type: "post", id: "p1", authorId: "1", body: "Hello" })

// Query with auto-indexing
const posts = rdb.query({
  match: { p: { from: "post" } },
  where: { "p.authorId": "1" },
  sort: ["p.createdAt"]
})
```

See [getting-started.md](getting-started.md) for more RecordDb examples.

## SyncDb Layer (Replication)

SyncDb wraps a TupleDb to provide history tracking and clock-based synchronization. It maintains three subspaces: `clock`, `history`, and `data`.

```typescript
type SyncDb = {
  clock(): number
  history(range?: ListArgs<Tuple>): { key: Tuple; value: Commit }[]
  data: TupleDb
  apply(commit: CommitMeta & { ops: Op[] }): void
}
```

### syncDb

Creates a scoped sync database with history tracking:

```typescript
const sdb = syncDb(db.subspace(["todoList", listId]), todoListReducers)

// Apply a commit (increments clock, stores in history, runs reducers on data subspace)
sdb.apply({
  id: "commit-1",
  authorId: "user-1",
  ops: [{ fn: "setTodo", args: [todo] }]
})

// Read current clock
sdb.clock()  // 1

// Read history since a clock value
sdb.history({ gte: [lastClock] })

// Access data
sdb.data.get(["todo", todoId])
```

### appDb

Handles commit processing with deduplication and reducer dispatch:

```typescript
const app = appDb(db, reducers)

// Query data at a path (returns clock for sync)
const { clock, data } = app.list(["users", userId], range)

// Write commits with idempotency
app.write({
  id: "commit-1",           // Enables deduplication
  authorId: "user-1",
  ops: [{ fn: "setList", args: [list] }]
})
```

Key features:
- **Deduplication**: Commits with the same `id` are only applied once
- **Reducer dispatch**: Operations are routed to the appropriate reducer
- **Scoped queries**: `list` reads from a path with clock metadata

### syncServer

Server-side orchestration combining appDb with transactions and pub/sub:

```typescript
const server = syncServer(db, pubsub, reducers)

// Query (delegates to appDb.list)
const { clock, data } = server.list(path, range)

// Write (wrapped in transaction, publishes changes)
server.write({
  authorId: "user-1",
  ops: [{ fn: "addTodo", args: [todo] }]
})
```

### Reducers

Type-safe functions that handle operations:

```typescript
type Reducer = (tx: TupleDb, commit: CommitMeta, ...args: any[]) => void
type ReducerMap = Record<string, Reducer>

const todoListReducers = {
  setTodo: (tx: TupleDb, commit: CommitMeta, todo: Todo) => {
    tx.set(["todo", todo.id], todo)
    tx.set(["all", todo.order, todo.id], null)
  }
} satisfies ReducerMap
```

Reducers receive:
- `tx`: The TupleDb (or data subspace) to write to
- `commit`: Metadata including `authorId` for authorization
- `...args`: Type-safe operation arguments

### Multi-Scope Pattern

App-level reducers fan out to multiple scoped syncDbs:

```typescript
const todoAppReducers = {
  setList: (tx: TupleDb, commit: CommitMeta, list: TodoList) => {
    // Each scope gets its own clock and history
    syncDb(tx.subspace(["users", commit.authorId]), userReducers).apply({
      ...commit,
      ops: [{ fn: "setList", args: [list] }]
    })
    syncDb(tx.subspace(["todoList", list.id]), todoListReducers).apply({
      ...commit,
      ops: [{ fn: "setList", args: [list] }]
    })
  }
} satisfies ReducerMap
```

## Range Abstractions

Sophisticated range handling for queries and subscriptions:

### Range Encoding

```typescript
// Open/closed boundary encoding as 3-tuples
type Bound = ["<" | ">" | "[" | "]", value?, inclusive?]

encodeRange({ gt: 1, lte: 5 })  // { lower: [">", 1], upper: ["≤", 5] }
```

### RangeTree

Dual-index structure for efficient overlap queries:

```typescript
const tree = rangeTree<K, V>(compare)
tree.set({ range, value })
tree.overlap({ gt, lt })  // Find all ranges that overlap
```

### RangeEmitter

Pub/sub for range-based reactivity:

```typescript
const emitter = rangeEmitter<K>(compare)
const unsub = emitter.subscribe({ gte, lt }, () => { /* onChange */ })
emitter.emit([{ gte, lte }])  // Notifies overlapping subscribers
```

## Data Flow Example

Write flow through layers:

```
Application: db.set(["users", 1], { name: "Chet" })
     ↓
TupleDb: write({ set: [{ key: ["users", 1], value: {...} }] })
     ↓
KeyEncodeOKV: encode key to "["users"#1"
     ↓
ValueEncodeOKV: JSON.stringify value
     ↓
SQLiteOkv: INSERT OR REPLACE INTO data VALUES (?, ?)
```

Read flow:

```
Application: db.get(["users", 1])
     ↓
TupleDb: list({ gte: key, lte: key }).at(0)?.value
     ↓
KeyEncodeOKV: encode bounds, decode results
     ↓
SQLiteOkv: SELECT * FROM data WHERE key >= ? AND key <= ?
     ↓
ValueEncodeOKV: JSON.parse results
```
