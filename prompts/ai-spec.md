# TupleDB Application Architecture

This document refines and clarifies the architecture for building applications on TupleDB, based on the human spec and implemented abstractions.

## Overview

TupleDB is a FoundationDB-inspired, transactional, ordered key-value store. This architecture layers on top of TupleDB to provide:

1. **SyncDb** - A syncable unit with history tracking, enabling clients to stay up-to-date
2. **AppDb** - A global write API that dispatches to multiple SyncDbs atomically
3. **PubSub** - Realtime notifications when SyncDbs change
4. **Client Cache** - Browser-side caching with optimistic updates (TODO)

The key insight is **separation of concerns**:
- **AppDb** handles writes at the application level (horizontally scalable, no history)
- **SyncDb** handles sync at the entity level (has history, clients subscribe to these)

---

## Core Abstractions

### TupleDb
The foundation. An ordered key-value store where keys are tuples (arrays) and values are JSON.

```typescript
type TupleDb = {
  get(key: Tuple): JSONValue | undefined
  set(key: Tuple, value: JSONValue): void
  delete(key: Tuple): void
  list(args?: ListArgs<Tuple>): { key: Tuple; value: JSONValue }[]
  subspace(prefix: Tuple): TupleDb
}
```

### SyncDb
A TupleDb subspace with history tracking. Each SyncDb maintains:
- `["clock"]` - Monotonically increasing version number
- `["history", clock]` - Commit log (operations + metadata)
- `["data", ...]` - Actual user data

```typescript
// Storage layout for a SyncDb at ["users", "alice"]
["users", "alice", "clock"] → 5
["users", "alice", "history", 1] → { id: "...", ops: [...], commitedAt: "..." }
["users", "alice", "history", 2] → { ... }
["users", "alice", "data", "profile"] → { name: "Alice" }
["users", "alice", "data", "inbox", "2024-01-01", "msg1"] → null
```

SyncDbs are the **unit of sync** - clients subscribe to a SyncDb's clock and pull history to stay current.

### AppDb
The global write API. It:
- Accepts domain-level operations (not raw SyncDb ops)
- Maintains idempotency via `["seen", txId]`
- Dispatches to multiple SyncDbs in a single transaction
- Writes to an outbox for reliable pubsub notifications
- Does NOT maintain its own history (scalability)

```typescript
type AppDb = {
  write(txId: string, ops: AppOp[]): Promise<{
    affectedScopes: { scope: Tuple; clock: number }[]
  }>
}
```

### Relationship: AppDb → SyncDbs

```
┌──────────────────────────────────────────────────────────────────────┐
│                            AppDb                                      │
│  - Idempotency: ["seen", txId]                                       │
│  - No history at this level                                          │
│  - Horizontally scalable                                             │
│                                                                      │
│  AppReducers: { set, delete, createUser, sendMessage, ... }          │
│                          │                                           │
│                          ▼                                           │
│  ┌─────────────────┬─────────────────┬─────────────────┐            │
│  │    SyncDb       │    SyncDb       │    SyncDb       │            │
│  │ ["users","a"]   │ ["users","b"]   │ ["lists","1"]   │            │
│  │                 │                 │                 │            │
│  │ clock: 5        │ clock: 12       │ clock: 3        │            │
│  │ history: [...]  │ history: [...]  │ history: [...]  │            │
│  │ data: {...}     │ data: {...}     │ data: {...}     │            │
│  └─────────────────┴─────────────────┴─────────────────┘            │
│                                                                      │
│  Outbox → PubSub → WebSocket → Clients                               │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### Write Path (Server)

1. **Client submits commit** to AppDb with a unique `txId`
   ```typescript
   appDb.write("tx-123", [
     { fn: "sendMessage", args: { from: "alice", to: ["bob"], body: "Hello" } }
   ])
   ```

2. **AppDb checks idempotency** via `["seen", txId]`
   - If seen, return immediately (safe to retry)
   - If not seen, mark as seen and proceed

3. **AppReducer dispatches to SyncDbs**
   ```typescript
   function sendMessage(tx: TupleDb, args: Message) {
     // Write to sender's SyncDb
     applyCommit(tx.subspace(["users", args.from]), userReducers, {
       ops: [{ fn: "addToOutbox", args: [args] }]
     })

     // Write to each recipient's SyncDb
     for (const userId of args.to) {
       applyCommit(tx.subspace(["users", userId]), userReducers, {
         ops: [{ fn: "addToInbox", args: [args] }]
       })
     }

     return { affectedScopes: [["users", args.from], ...args.to.map(id => ["users", id])] }
   }
   ```

4. **applyCommit writes to each SyncDb**
   - Increment clock
   - Write to history with server timestamp
   - Apply operations to data subspace

5. **Outbox entry written transactionally**
   ```typescript
   tx.set(["outbox", Date.now()], {
     scopes: [
       { scope: ["users", "alice"], clock: 6 },
       { scope: ["users", "bob"], clock: 13 }
     ]
   })
   ```

6. **Transaction commits** - all writes are atomic

7. **OutboxProcessor publishes** clock values to PubSub
   ```typescript
   pubsub.channel(["users", "alice"]).publish(6)
   pubsub.channel(["users", "bob"]).publish(13)
   ```

### Read Path (Server → Client)

1. **Client subscribes to SyncDb clock** via PubSub/WebSocket
   ```typescript
   pubsub.channel(["users", "alice"]).subscribe(clock => {
     if (clock > localClock) syncFromServer()
   })
   ```

2. **Client fetches history** since last known clock
   ```typescript
   const { clock, updates } = await fetchApi.fetch(["users", "alice"], localClock)
   ```

3. **Client applies updates** to local cache
   - For each commit in history, replay operations
   - Update local clock

4. **Client fetches data ranges** as needed
   ```typescript
   const { clock, updates, data } = await fetchApi.read(
     ["users", "alice"],
     { gte: ["inbox"], lte: ["inbox", null] },
     localClock
   )
   ```

---

## Commit Metadata

Every commit carries metadata that flows through the system:

```typescript
type CommitMeta = {
  id: string        // Unique ID for idempotency and correlation
  authorId?: string // Who made this commit (for authorization)
  createdAt: string // ISO timestamp when client created it
}

type Commit = CommitMeta & {
  clock: number      // Assigned by server
  commitedAt: string // ISO timestamp when server processed it
  ops: Op[]          // Operations to apply
}
```

**Key points:**
- `id` is used for idempotency at the AppDb level and correlates across SyncDbs
- `authorId` enables authorization checks in reducers
- `createdAt` vs `commitedAt` distinguishes client intent time from server commit time (important for offline editing)
- `clock` is assigned by the server and monotonically increases per SyncDb

---

## Storage Layout

### Global (AppDb level)
```
["seen", txId] → timestamp           # Idempotency tracking
["outbox", timestamp] → { scopes }   # Pending pubsub notifications
```

### Per SyncDb (e.g., ["users", "alice"])
```
["users", "alice", "clock"] → number
["users", "alice", "history", clock] → Commit
["users", "alice", "data", ...] → user data
```

### Example: Messaging App
```
# User "alice" SyncDb
["users", "alice", "clock"] → 5
["users", "alice", "history", 1] → { ops: [...], ... }
["users", "alice", "data", "message", "msg1"] → { from, to, body, datetime }
["users", "alice", "data", "inbox", "2024-01-01T10:00:00Z", "msg1"] → null
["users", "alice", "data", "outbox", "2024-01-01T09:00:00Z", "msg2"] → null
```

### Example: TodoMVC
```
# TodoList "list1" SyncDb
["todoList", "list1", "clock"] → 3
["todoList", "list1", "history", 1] → { ... }
["todoList", "list1", "data", "name"] → "My Todos"
["todoList", "list1", "data", "todo", "todo1"] → { text, checked, order }
["todoList", "list1", "data", "all", "a", "todo1"] → null      # Index by order
["todoList", "list1", "data", "checked", "a", "todo1"] → null  # Filtered index
```

---

## PubSub & Realtime

### Design Principles

1. **Only publish clock values** - No data, just "SyncDb X is now at clock Y"
2. **Unauthenticated channels** - Clock values are not sensitive
3. **Transactional outbox** - Crash-safe, exactly-once delivery

### Server-Side API (Implemented)

```typescript
// PubSub types
type PubSubChannel<T> = {
  subscribe(listener: (value: T) => void): () => void
  publish(value: T): void
}

type PubSub<T> = {
  channel(key: Tuple): PubSubChannel<T>
}

// InMemoryPubSub for testing
class InMemoryPubSub<T> implements PubSub<T> { ... }

// OutboxProcessor for reliable delivery
function processOutbox(db: TupleDb, outboxPrefix: Tuple, pubsub: SyncPubSub): void
```

### Client-Side API (TODO)

```typescript
type ClientPubSub = {
  subscribe(key: Tuple): void
  unsubscribe(key: Tuple): void
  onMessage(listener: (key: Tuple, value: number) => void): () => void
}
```

### WebSocket Protocol (Future)
```
Client → Server: { type: "subscribe", key: ["users", "alice"] }
Server → Client: { type: "clock", key: ["users", "alice"], value: 5 }
Client → Server: { type: "unsubscribe", key: ["users", "alice"] }
```

---

## Client Cache (TODO)

The client cache enables:
1. **Local reads** - Fast UI without server roundtrips
2. **Optimistic updates** - Immediate feedback on writes
3. **Sync reconciliation** - Merge server state with local changes

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client                                    │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    TupleCache                             │  │
│  │                                                           │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │  │
│  │  │ SyncDb      │  │ SyncDb      │  │ Optimistic  │       │  │
│  │  │ cached data │  │ cached data │  │ writes      │       │  │
│  │  │ clock: 5    │  │ clock: 12   │  │ pending: [] │       │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘       │  │
│  │                                                           │  │
│  │  Subscriptions (reference counted)                        │  │
│  │  Range queries (cached with bounds)                       │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          │                                      │
│                          ▼                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   PubSub     │  │  Fetch API   │  │  Write API   │          │
│  │  (WebSocket) │  │   (HTTP)     │  │   (HTTP)     │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

### Key Concepts

**Subscription Reference Counting:**
```typescript
// Multiple components can subscribe to same SyncDb
useEffect(() => {
  subscriptions.inc(["users", "alice"])
  return () => subscriptions.dec(["users", "alice"])
}, [])
// Only unsubscribe from server when refcount hits 0
```

**Optimistic Updates:**
```typescript
function write(commit: Commit) {
  // 1. Apply locally immediately
  applyOptimistically(cache, appReducers, commit)

  // 2. Queue for server
  writeQueue.push(commit)

  // 3. On server response, reconcile
  // - Remove from optimistic layer
  // - Apply server's version of changes
}
```

**Sync Reconciliation:**
```typescript
function onClockUpdate(scope: Tuple, serverClock: number) {
  const localClock = cache.getClock(scope)
  if (serverClock > localClock) {
    // Fetch missing history
    const { updates } = await fetchApi.fetch(scope, localClock)

    // Apply updates to base layer
    for (const commit of updates) {
      applyToCache(cache, commit)
    }

    // Rebase optimistic writes
    rebaseOptimisticWrites(cache, scope)
  }
}
```

### React Hooks (Future API)

```tsx
// Subscribe to a SyncDb and get a handle for queries
function useSyncDb(cache: TupleCache, scope: Tuple): SyncDbHandle

// Query a range, returns { local, remote }
function useList(db: SyncDbHandle, args: ListArgs): QueryResult

// Query a single key
function useGet(db: SyncDbHandle, key: Tuple): QueryResult

// Write to AppDb (not SyncDb directly)
function useWrite(cache: TupleCache, reducers: AppReducerMap): WriteFn
```

**Example usage:**
```tsx
function Inbox({ userId }: { userId: string }) {
  const userDb = useSyncDb(cache, ["users", userId])
  const { local, remote } = useList(userDb.subspace(["data", "inbox"]), { limit: 20 })

  if (local.miss) return <Loading />

  return (
    <div>
      {local.hit.map(({ key }) => (
        <Message key={key.at(-1)} messageId={key.at(-1)} />
      ))}
    </div>
  )
}
```

---

## Example: Messaging App

### Domain Types
```typescript
type User = { type: "user"; id: string; name: string }
type Message = { type: "message"; id: string; from: string; to: string[]; datetime: string; body: string }
```

### App Reducers (Global Level)
```typescript
const appReducers = {
  set(tx: TupleDb, commit: CommitMeta, value: User | Message) {
    if (value.type === "message") {
      // Fan out to sender and recipients
      const msg = value as Message

      applyCommit(tx.subspace(["users", msg.from]), userReducers, {
        ...commit,
        ops: [{ fn: "sendMessage", args: [msg] }]
      })

      for (const userId of msg.to) {
        applyCommit(tx.subspace(["users", userId]), userReducers, {
          ...commit,
          ops: [{ fn: "receiveMessage", args: [msg] }]
        })
      }

      return { affectedScopes: [["users", msg.from], ...msg.to.map(id => ["users", id])] }
    }
    // ... handle other types
  },

  delete(tx: TupleDb, commit: CommitMeta, ref: { type: string; id: string }) {
    // ... fan out deletes
  }
}
```

### User Reducers (SyncDb Level)
```typescript
const userReducers = {
  sendMessage(tx: TupleDb, commit: CommitMeta, msg: Message) {
    tx.set(["message", msg.id], msg)
    tx.set(["outbox", msg.datetime, msg.id], null)
  },

  receiveMessage(tx: TupleDb, commit: CommitMeta, msg: Message) {
    tx.set(["message", msg.id], msg)
    tx.set(["inbox", msg.datetime, msg.id], null)
  },

  deleteMessage(tx: TupleDb, commit: CommitMeta, id: string) {
    const msg = tx.get(["message", id]) as Message | undefined
    if (!msg) return

    tx.delete(["message", id])
    tx.delete(["outbox", msg.datetime, id])
    tx.delete(["inbox", msg.datetime, id])
  }
}
```

---

## Example: TodoMVC

A simpler case where each todo list is its own SyncDb.

### Domain Types
```typescript
type TodoList = { id: string; name: string }
type Todo = { id: string; text: string; checked: boolean; order: string }
```

### App Reducers
```typescript
const appReducers = {
  createList(tx: TupleDb, commit: CommitMeta, args: { id: string; name: string }) {
    if (!commit.authorId) throw new Error("Must be logged in")

    // Add to user's list of lists
    const userDb = tx.subspace(["users", commit.authorId])
    const order = generateFractionalIndex(userDb, ["data", "lists"])

    applyCommit(userDb, userReducers, {
      ...commit,
      ops: [{ fn: "addList", args: [order, args.id] }]
    })

    // Create the list itself
    applyCommit(tx.subspace(["todoList", args.id]), todoReducers, {
      ...commit,
      ops: [{ fn: "init", args: [args.name] }]
    })

    return { affectedScopes: [["users", commit.authorId], ["todoList", args.id]] }
  },

  addTodo(tx: TupleDb, commit: CommitMeta, args: { listId: string; todo: Todo }) {
    applyCommit(tx.subspace(["todoList", args.listId]), todoReducers, {
      ...commit,
      ops: [{ fn: "addTodo", args: [args.todo] }]
    })

    return { affectedScopes: [["todoList", args.listId]] }
  },

  // ... more operations
}
```

---

## Implementation Status

| Component | Status | Location |
|-----------|--------|----------|
| TupleDb | ✅ Complete | `src/tupleDb/` |
| SyncDb | ✅ Complete | `src/syncDb/SyncDb.ts` |
| applyCommit | ✅ Complete | `src/syncDb/SyncServer.ts` |
| AppDb | ✅ Complete | `src/syncDb/AppDb.ts` |
| PubSub (InMemory) | ✅ Complete | `src/syncDb/PubSub.ts` |
| OutboxProcessor | ✅ Complete | `src/syncDb/OutboxProcessor.ts` |
| FetchApi | ✅ Complete | `src/syncDb/FetchApi.ts` |
| CommitMeta in reducers | ❌ TODO | Need to thread through |
| Client Cache | ❌ TODO | Design above |
| WebSocket PubSub | ❌ TODO | Real implementation |
| HTTP API layer | ❌ TODO | Express/Fastify wrappers |

---

## Future Roadmap

### Near-term
1. **Thread CommitMeta through reducers** - Enable authorization
2. **Client Cache implementation** - TupleCache + optimistic updates
3. **HTTP API wrappers** - Express handlers for write/fetch/read
4. **WebSocket PubSub** - Real implementation

### Medium-term
1. **Record indexing abstraction** - Simpler than full IVM, handles common cases
2. **Fractional indexing helpers** - For ordered lists
3. **Authorization framework** - Declarative rules based on authorId

### Long-term
1. **Full SyncDb replication** - For p2p or realtime backups
2. **P2p sync** - Vector clocks, CRDT-style merging
3. **Offline-first client** - Persistent queue, background sync

---

## Key Design Decisions

### Why separate AppDb and SyncDb?

**Scalability**: AppDb has no history, so it can scale horizontally. Multiple servers can process writes without coordinating history order. SyncDbs have history but are scoped to individual entities (users, lists), keeping them manageable.

**Flexibility**: App-level operations can touch multiple SyncDbs atomically. A "send message" creates history entries in both sender and recipient SyncDbs from one AppDb write.

**Client simplicity**: Clients only need to track clocks for the SyncDbs they care about. They don't need global coordination.

### Why transactional outbox?

**Crash safety**: If the server crashes after commit but before publish, the outbox entry survives. On restart, OutboxProcessor resumes publishing.

**Exactly-once semantics**: The outbox entry is deleted only after successful publish. Combined with client-side clock comparison, this ensures no missed or duplicate updates.

### Why only publish clocks (not data)?

**Security**: Clock values are not sensitive. Publishing actual data would require authentication on every pubsub channel.

**Efficiency**: Small payloads. Clients pull data only when needed.

**Simplicity**: One subscription model for all SyncDbs.
