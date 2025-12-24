# SyncDb Implementation Plan

This document outlines the plan for implementing a robust synchronization mechanism for `TupleDb`, enabling optimistic updates, offline capabilities, and client-server syncing with logical clocks.

## 1. Core Concepts & Data Model

We introduce a `SyncDb` layer that wraps `TupleDb`. It manages three logical components:

1.  **Clock**: A monotonically increasing integer representing the version of the database.
2.  **History**: An ordered log of high-level **Operations**.
3.  **Data**: The materialized key-value state (indexes, objects) derived from operations.

### The Operation
An `Operation` represents a user intent that produces changes in the database.

```ts
type Operation = {
  fn: string;   // e.g., "sendMessage"
  args: any[];  // e.g., [{ id: 1, text: "hi" }]
  timestamp: number;
};
```

Both Client and Server share a **Registry** of reducer functions:
```ts
type Reducer = (tx: Transaction, ...args: any[]) => void;
const reducers: Record<string, Reducer> = {
  sendMessage: (tx, msg) => {
    tx.set(["inbox", msg.id], msg);
    tx.set(["sent", msg.id], msg);
  }
};
```

## 2. Server Architecture (Authority)

The server is the source of truth.
- It maintains the canonical **Clock** and **History**.
- When it receives an `Operation`:
  1.  Assigns it the next `Clock` tick.
  2.  Writes it to `["history", clock]`.
  3.  Executes the reducer to update `["data", ...]`.
- It exposes endpoints to:
  - **Push**: Accept new operations.
  - **Pull**: Return operations since a given clock.
  - **Fetch**: Return a snapshot of data for a specific range (for initial hydration).

## 3. Client Architecture

The client is designed for optimistic interaction.

### State Management
- **Confirmed State**: The state derived from operations confirmed by the server (persisted in local `TupleDb`).
- **Pending State**: Operations generated locally but not yet acknowledged by the server.
- **Cache Layer**: A `Cache` instance (from `@src/tupleDb/Cache.ts`) sits on top. It serves reads and tracks range queries.

### The "Sync Loop"
The client maintains a `syncedClock`.
1.  **Optimistic Apply**: When user calls `db.dispatch("sendMessage", msg)`:
    - We immediately run the reducer against the `Cache`.
    - We append the operation to a local `pendingOperations` queue.
    - UI updates immediately.
2.  **Push**: Periodically (or immediately), send `pendingOperations` to server.
3.  **Pull / Rebase**:
    - Fetch new operations from server (starting from `syncedClock`).
    - **Revert** local pending writes from the `Cache`.
    - **Apply** server operations to local `TupleDb` (updating `syncedClock`).
        - *Crucial*: When applying server ops, we only materialize writes to ranges/subspaces we are "subscribed" to (Pruning).
    - **Re-Apply** remaining pending operations to `Cache` (on top of new state).

### Pruning / Partial Replication
Since the client cannot store the entire server DB:
- The client "Subscribes" to specific prefixes (e.g., `["user", 123]`).
- When playing back History (whether from server or local pending), we capture the `tx` writes.
- We filter these writes: `if (writeKey startsWith subscribedPrefix) apply() else ignore()`.
- This ensures the client only stores relevant data, even if the Operation ("sendMessage") touched other users' inboxes.

## 4. Developer API

### Client Setup
```ts
// Initialize with server connection and reducer registry
const syncDb = new SyncClient({
  db: localTupleDb,
  remote: serverApi,
  reducers: { sendMessage, ... }
});

// Subscribe to a slice of data
syncDb.subscribe(["user", "me"]);
```

### Component Usage
```tsx
function Inbox() {
  // Use a subspace for convenient keys
  const userDb = useSyncDb(syncDb, ["user", "me"]);
  
  // Reactive list query
  // Internally calls cache.list(). If miss, triggers fetch(range) from server?
  // OR we rely on 'subscribe' to have pre-loaded the data via history sync.
  const inbox = useList(userDb, ["inbox"], { limit: 20, reverse: true });

  if (inbox.miss) return <Spinner />;

  return (
    <div>
      {inbox.items.map(msg => <Message data={msg} />)}
      <button onClick={() => {
        // Dispatch an action (Optimistic)
        userDb.dispatch("sendMessage", { text: "Hello" });
      }}>Send</button>
    </div>
  )
}
```

### Handling "Misses" (Lazy Loading vs Sync)
Pure history sync works for updates, but initial load needs data.
- **Hybrid Strategy**:
  - `useList` checks Cache.
  - If `miss`, client calls `server.fetchRange(range)`.
  - Server returns current KVs *and* the current `serverClock`.
  - Client writes KVs to local DB and updates `syncedClock` (if older).
  - *Complexity*: syncing history vs fetching snapshots. 
  - *Simplification*: We assume we "subscribe" to a subspace, which does an initial fetch-all-in-range, then switches to history-tailing mode.

## 5. Implementation Plan

### Step 1: Types & Core Logic
- Define `Operation`, `SyncDb` interface.
- Implement `applyOperation(db, op, reducers)` helper.

### Step 2: SyncClient Class
- `pendingOps`: Queue.
- `dispatch(fn, args)`: Handles optimistic update + queue.
- `receive(ops)`: Handles applying server ops + rebase.
- `prune(writes)`: Logic to filter writes based on active subscriptions.

### Step 3: Mock Server
- In-memory `TupleDb` acting as authority.
- `push(ops)` endpoint.
- `pull(sinceClock)` endpoint.

### Step 4: React Integration
- `useSyncDb` hook providing the context.
- `useList` hook binding to `Cache.subscribe`.

### Step 5: Testing
- **Fuzz Test**: Random operations on Client A and Client B. Ensure they eventually converge to same state as Server.
- **Disconnect Test**: Perform ops while "offline", then reconnect and verify sync.

## 6. Directory Structure
- `src/tupleDb/sync/SyncClient.ts`
- `src/tupleDb/sync/SyncServer.ts`
- `src/tupleDb/sync/types.ts`
- `src/tupleDb/sync/react.ts`
