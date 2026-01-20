# TupleDb

This is a simple implemention of a foundationdb-inspired tuple database written in TypeScript.

The goal is to use this database on top of SQLite on a Node.js server and in-memory in the browser. Using the same database abstractions in both places makes it much easier to build web apps with optimistic updates and offline tolerance.

## Okv

The lowest level is an ordered-key-value store. `list` to read ranges, `write` to write data, and `compare` so that we can build intermediate caching mechanisms.

```ts
export type Okv<K, V> = {
	compare: (a: K, b: K) => number
	list(args?: ListArgs<K>): { key: K; value: V }[]
	write: (tx: WriteArgs<K, V>) => void
}
```

Most persisted okv's will store string keys and string values such as Sqlite: `class SQLiteOkv implements Okv<string, string>`.

When building an in-memory okv however, we don't need to serialize values so we get `Okv<string | number, any>` for free.

## TupleOkv

To get a tuple database, we need to do some encoding of tuples into lexicographically ordered strings and wrap the Okv api. That's exactly what the functions in `Codec.ts` and `Encoder.ts` help with. In practice, you can just do this:

```ts
// For a persisted database
const base = tupleOkv(new SqliteOkv("app.db"))
// For an in-memory database
const base = new InMemoryOkv(codec.compare)
```

While we can do `tupleOkv(new InMemoryDatabase())`, we'd be serializing keys when we don't have to so its much more performant just to pass a custom compare function.

## TupleDb

The base tupleDb is great for building abstractions on top of, but it's a bit cumbersome to use and that's what `tupleDb` is for.

```ts
const db = tupleDb(base)

db.set(["users", 1], { id: 1, name: "Chet" })
db.has(["users", 1])
db.get(["users", 1])
db.delete(["users", 1])

const users = db.subspace(["users"])
users.set(2, { id: 2, name: "Simon" })
```

Functions compose really well for writing to the database. You have full flexibility to update indexes and fan out however you want.

```ts
function fanoutSendMessage(tx: TupleDb, msg: Message) {
	for (const to of msg) tx.set(["inbox", to, msg.timestamp, msg.id], null)
}

function sendMessage(tx: TupleDb, msg: Message) {
	tx.set(["message", msg.id], msg)
	fanoutSendMessage(msg)
	// More firebase-inspired way to index messages nested inside the user.
	tx.subspace(["user", msg.from]).set(["sent", msg.timestamp, msg.id], msg)
}

const tx = tupleTx()
sendMessage(tx, msg)
tx.commit()
```

Transactions will batch all writes, but it doesn't do any actual concurrency control. That shouldn't be necessary though since the database is synchronous.


## Cache

The `Cache` is the workhorse of the client-side database. However it's pretty minimal and we need to build some more abstractions to make the entire system work well.

```ts
const cache = new Cache<Tuple, JSONValue>(codec.compare)

const listUsersArg = { gt: ["users"], lt: ["users", "\xff"], limit: 100 }
const data = db.list(listUsersArg)

// Insert data into the cache overwriting any previous data in that range.
cache.insert([{ args: listUsersArg, result: data }])

// Optimistically write data into the cache.
const finalize = cache.write({ key, value })

// Write to the database
db.write({ key, value })
// Once the write succeeds, we can insert it into the cache and finalize the optimistic write
cache.insert([{ args: { gte: key, lte: key }, result: [{ key, value }] }])
finalize()

// Subscribe to a query.
cache.subscribe(listUsersArg, () => {
	// Users updated!
	const result = cache.list(listUsersArg)
	if (cache.miss) {
		// Not in the cache
	} else if (cache.prefix) {
		// We currently have a prefix subset of the results.
	} else if (cache.hit) {
		// We have all the results of the query.
	}
})
```

## Transaction

Transactions essentially use a cache in between the database to aggregate writes before sending committing. There is no concurency control and these transactions are not ACID. They're merely a useful way of writing to the database.

```ts
const tx = tupleTx(db)
tx.set(...)
tx.commit()
```

## SyncDb

SyncDb provides history tracking and clock-based synchronization for replication scenarios. It wraps a TupleDb and maintains separate `clock`, `history`, and `data` subspaces.

```ts
import { syncDb } from "./src/syncDb/syncDb"

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

// Access data subspace
sdb.data.get(["todo", todoId])
```

### Reducers

Reducers are type-safe functions that handle operations. They receive the transaction, commit metadata (for authorization), and operation args.

```ts
import { CommitMeta, ReducerMap } from "./src/syncDb/types"

const todoListReducers = {
  setTodo: (tx: TupleDb, commit: CommitMeta, todo: Todo) => {
    tx.set(["todo", todo.id], todo)
    tx.set(["all", todo.order, todo.id], null)
    if (todo.checked) tx.set(["checked", todo.order, todo.id], null)
    else tx.set(["unchecked", todo.order, todo.id], null)
  },

  deleteTodo: (tx: TupleDb, commit: CommitMeta, todoId: string) => {
    const todo = tx.get(["todo", todoId])
    if (!todo) return
    tx.delete(["todo", todoId])
    tx.delete(["all", todo.order, todoId])
  }
} satisfies ReducerMap
```

### Multi-Scope Sync

App-level reducers can fan out to multiple scoped syncDbs:

```ts
const todoAppReducers = {
  setList: (tx: TupleDb, commit: CommitMeta, list: TodoList) => {
    if (!commit.authorId) throw new Error("You need to be logged in.")

    // Update user's list index
    syncDb(tx.subspace(["users", commit.authorId]), userReducers).apply({
      ...commit,
      ops: [{ fn: "setList", args: [list] }]
    })

    // Update the list itself
    syncDb(tx.subspace(["todoList", list.id]), todoListReducers).apply({
      ...commit,
      ops: [{ fn: "setList", args: [list] }]
    })
  }
} satisfies ReducerMap
```

## AppDb

AppDb handles client commits with deduplication and reducer dispatch. It's used by syncServer for request handling.

```ts
import { appDb } from "./src/syncDb/appDb"

const app = appDb(db, reducers)

// Query data at a scoped path
const { clock, data } = app.list(["users", userId], { gte: ["list"], lt: ["list", null] })

// Write a commit (with automatic deduplication)
app.write({
  id: "commit-1",           // Optional - enables idempotent writes
  authorId: "user-1",
  ops: [{ fn: "setList", args: [list] }]
})
```

## SyncServer

SyncServer orchestrates appDb with transactions and pub/sub for server-side sync:

```ts
import { syncServer } from "./src/syncDb/syncServer"

const server = syncServer(db, pubsub, reducers)

// Query data
const { clock, data } = server.list(["users", userId], range)

// Write commits (wrapped in transaction, publishes changes)
server.write({
  authorId: "user-1",
  ops: [{ fn: "setTodo", args: [todo] }]
})
```
