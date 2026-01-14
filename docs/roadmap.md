# Roadmap

## Vision

TupleDB aims to provide a unified database abstraction for building web applications with:

- **Optimistic updates** - Immediate UI response with background sync
- **Offline tolerance** - Work without network, sync when available
- **Incremental view maintenance** - Automatically maintained indexes and aggregations
- **Same abstractions everywhere** - Identical API on client (browser) and server (Node.js)

## Current State

### Complete

- **TupleDb Core** - Ordered key-value store with transactions, subspaces
- **Storage Backends** - InMemory and SQLite implementations
- **RecordDb** - Schema layer with auto-indexing, joins, aggregations, IVM
- **OkvCache** - Client-side cache with hit/miss/prefix semantics
- **SyncDb Server** - History tracking and replication API

### In Progress

- **SyncDb Client** - Client-side sync with optimistic writes

## Near-Term: Complete SyncDb Client

The client needs to integrate cache, sync, and reactivity:

```typescript
// Target API
const client = new SyncClient({
  api: serverApi,      // HTTP/WebSocket adapter
  pubsub: pubsubConn,  // Real-time clock updates
  reducers            // Operation handlers
})

// Subscribe to a syncDb scope
const userDb = client.syncDb(["user", userId])

// Reactive queries with hit/miss/prefix
const { local, remote, unsubscribe } = userDb.data.subscribe(
  { gte: ["inbox"], lt: ["inbox", null], limit: 20 },
  ({ hit, miss, prefix }) => {
    // Called on changes (local optimistic or remote sync)
  }
)

// Optimistic writes
userDb.write({ authorId: userId }, ops => {
  ops.sendMessage({ id: "m1", body: "Hello", to: ["u2"] })
})
```

Key challenges:

1. **Clock synchronization** - Track server clock, detect gaps
2. **Optimistic write queue** - Pending writes applied locally, sent to server
3. **Conflict resolution** - Server authority, client rollback
4. **Cache pruning** - Evict data for unsubscribed ranges

## Mid-Term: Enhanced Query Capabilities

### Comparison Operators

```typescript
db.query({
  match: { p: { from: "post" } },
  where: {
    "p.authorId": "u1",
    "p.createdAt": { $gte: "2024-01-01" }
  }
})
```

Operators: `$gt`, `$gte`, `$lt`, `$lte`, `$ne`

Challenge: Compound indexes with alternating sort directions require investigating lexicodec encoding strategies.

### Union Queries

```typescript
db.query({
  match: { p: { from: "post" } },
  where: {
    "p.tag": { $in: ["basketball", "soccer"] }
  }
})
```

### More Aggregations

- `sum` - Sum numeric values
- `avg` - Average (requires sum + count)
- `min` - Minimum value
- `unique` / `distinct` - Deduplicated values

### N-Way Joins

Current joins support 2-way. Extend to arbitrary chains:

```typescript
// Friends of friends of friends
db.query({
  match: {
    a: { from: "follow" },
    b: { from: "follow", on: { fromId: "a.toId" } },
    c: { from: "follow", on: { fromId: "b.toId" } }
  },
  where: { "a.fromId": "u1" }
})
```

## Long-Term: Advanced Features

### Index Optimization

Analyze queries to find index consolidation opportunities:

```typescript
// These queries:
query({ where: { a: 1, b: 2 }, sort: ["c"] })
query({ where: { b: 3 }, sort: ["a"] })

// Could share index [b, a, c] instead of two separate indexes
const analysis = analyzeIndexes(schema)
optimizeIndexes(analysis)
```

### Conditional Indexes

Partial indexes for common filters:

```typescript
createIndex({
  match: { p: { from: "post" } },
  where: { "p.published": true },  // Only index published posts
  sort: ["p.createdAt"]
})
```

### Schema Introspection

Store schema as queryable records:

```typescript
// Current: Schema stored as single blob
["_schema", "types", "user"]: { primary: ["id"] }

// Future: Schema as individual records, enabling index-on-indexes
["_meta", "type", "user"]: { primary: ["id"] }
["_meta", "index", "user_by_name"]: { type: "user", sort: ["name", "id"] }

// Query which indexes need updating for a type
db.query({
  match: { i: { from: "_meta/index" } },
  where: { "i.type": "user" }
})
```

### P2P Sync

Extend SyncDb for peer-to-peer replication:

```typescript
// Each peer is a full replica
const peer1 = syncDb(storage1)
const peer2 = syncDb(storage2)

// Bidirectional sync
function sync(a: SyncDb, b: SyncDb) {
  const aHistory = a.history.list({ gt: [b.clock()] })
  const bHistory = b.history.list({ gt: [a.clock()] })

  for (const commit of aHistory) b.write(commit)
  for (const commit of bHistory) a.write(commit)
}
```

### React Integration

```typescript
function useQuery<T>(db: RecordDb, query: Query): T[] {
  const [result, setResult] = useState<T[]>([])

  useEffect(() => {
    const update = () => setResult(db.query(query))
    update()
    return db.subscribe(query, update)
  }, [query])

  return result
}

// Usage
function UserList() {
  const users = useQuery(db, {
    match: { u: { from: "user" } },
    sort: ["u.name"]
  })

  return users.map(u => <User key={u.id} user={u} />)
}
```

## Example Applications

### TodoMVC (Single SyncDb)

Simple case: one syncDb per user, full fanout on server.

```typescript
// Server
const reducers = {
  addTodo: (tx, todo) => tx.set(["todos", todo.id], todo),
  toggleTodo: (tx, id) => {
    const todo = tx.get(["todos", id])
    tx.set(["todos", id], { ...todo, completed: !todo.completed })
  },
  deleteTodo: (tx, id) => tx.delete(["todos", id])
}

// Client subscribes to single scope
const userDb = client.syncDb(["user", userId])
userDb.data.subscribe({ gte: ["todos"], lt: ["todos", null] }, ...)
```

### Chat App (Multiple SyncDbs)

Users subscribe to multiple chatrooms:

```typescript
// Data model
type User = { type: "user", id: string, name: string }
type Room = { type: "room", id: string, memberIds: string[] }
type Message = { type: "message", id: string, roomId: string, body: string }

// Each room is a separate syncDb
const room1 = client.syncDb(["room", "r1"])
const room2 = client.syncDb(["room", "r2"])

// User profile is also a syncDb
const profile = client.syncDb(["user", userId])

// Subscribe to rooms the user is in
const rooms = profile.data.list({ gte: ["rooms"], lt: ["rooms", null] })
for (const room of rooms) {
  const roomDb = client.syncDb(["room", room.id])
  roomDb.data.subscribe({ gte: ["messages"], lt: ["messages", null], limit: 50 }, ...)
}
```

### Notion-like Documents

Nested documents with collaborative editing:

```typescript
// Document structure stored as records
type Block = {
  type: "block"
  id: string
  parentId: string | null
  order: string  // Fractional indexing for ordering
  content: any
}

// Each document is a syncDb
const doc = client.syncDb(["doc", docId])

// Query with RecordDb for hierarchy
const blocks = recordDb.query({
  match: { b: { from: "block" } },
  where: { "b.parentId": parentBlockId },
  sort: ["b.order", "b.id"]
})
```

## Contributing

Focus areas for contribution:

1. **SyncClient implementation** - Most impactful near-term work
2. **Comparison operators** - Unlock range queries in RecordDb
3. **Test coverage** - More edge cases, especially cache and sync
4. **Performance** - Profile and optimize hot paths
5. **Documentation** - Examples, tutorials, API reference
