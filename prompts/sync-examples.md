# SyncDb Architecture Examples

This document outlines the architecture for two different approaches to building a chat application using `tupledb`, `syncdb`, and `recorddb`.

## Core Concepts

*   **SyncDb**: A transactional, ordered, syncable key-value store. It separates *History* (commits/ops) from *Data* (materialized state).
*   **Subspace**: A prefix-based partition of the database (e.g., `["users", "alice"]`).
*   **Reducer**: Pure functions that apply operations to the database state.
*   **Fan-out (Example 1)**: Data is duplicated to every user's private subspace. Easy reads, expensive writes.
*   **Normalized (Example 2)**: Data lives in shared subspaces (e.g., Chatrooms). Users subscribe to multiple subspaces.

## Common Types

We define a shared set of domain objects for both examples.

```typescript
// Shared Domain Objects
type UserId = string
type ChatId = string
type MessageId = string

type User = {
    id: UserId
    username: string
    avatarUrl?: string
}

type UserProfile = {
    id: UserId
    bio: string
    status: "online" | "offline"
}

type Message = {
    id: MessageId
    chatId: ChatId
    fromId: UserId
    body: string
    createdAt: string
}

type Chatroom = {
    id: ChatId
    name: string
    memberIds: UserId[]
}
```

---

## Client-Side Architecture: Partial Replication & Cache-First

The client does **not** maintain a full replica of the database. Instead, it uses a **Cache-First** approach backed by `TupleCache`.

### TupleCache & SyncManager

The core idea is to provide a clean, reactive developer experience (DX) that hides the complexity of network sync, while giving full control over what data is loaded.

1.  **TupleCache**: The single source of truth for the UI. It holds whatever partial state has been loaded.
2.  **SyncManager**: Manages network requests, subscriptions, and optimistic updates.
3.  **Scoped Subscriptions**: Developers "subscribe" to a specific SyncDb path (subspace).

### Developer Experience (DX)

The API is designed to be simple and reactive.

```typescript
// 1. Get a handle to a specific SyncDb subspace (e.g., current user)
const userDb = client.sync(["users", "me"])

// 2. Query data. The callback fires immediately with cached data,
//    and again when data arrives from the server.
const unsubscribe = userDb.query({ prefix: ["todos"] }, (result) => {
   if (result.loading) showSpinner()
   renderTodos(result.data)
})

// 3. Write data. Updates cache optimistically, then syncs to server.
userDb.write(ops.addTodo("Buy milk"))

// 4. Cleanup when component unmounts
unsubscribe()
```

### The "Waterfall" Pattern

Real-world apps often require dependent data fetching. This architecture supports it naturally via nested subscriptions.

1.  **Fetch User**: Subscribe to `["user", "me"]` -> Get `chatIds`.
2.  **Fetch Chats**: Inside the user callback, map over `chatIds` and subscribe to each `["chat", id]`.
3.  **Render**: The UI updates incrementally as data flows in.

---

## Server Architecture

The server is a simplified composition of three parts:

1.  **Database**: A `TupleDb` that stores all data and history.
2.  **API**: Exposes `read`, `write`, and `fetch` endpoints.
3.  **PubSub**: Broadcasts `clock` updates when specific subspaces change.

---

## Example 1: Fan-out Architecture

In this model, every user has their own isolated `SyncDb` subspace. The server is responsible for distributing updates to all relevant users.

### Architecture

*   **Client**:
    *   Subscribes *only* to `["user", userId]` (the inbox).
    *   Submits actions (Intent) to the server.
    *   **Partial Data**: The client never sees the full DB, only its own inbox.
*   **Server**:
    *   Receives high-level operations.
    *   Executes logic to determine recipients.
    *   Writes low-level ops to each recipient's `SyncDb`.

### Reducers (Client View)

The client only sees the result of the fan-out.

```typescript
type FanOutReducers = {
    // Upsert a user object (fanned out from profile updates)
    putUser: (user: User) => void

    // Receive a message (fanned out from sender)
    putMessage: (msg: Message) => void

    // Update local user's own profile
    putProfile: (profile: UserProfile) => void
}
```

---

## Example 2: Normalized / Multi-Subspace Architecture

In this model, data is stored in shared subspaces (e.g., a specific Chatroom). Clients subscribe to multiple `SyncDb` instances.

### Architecture

*   **Client**:
    *   **Waterfall Subscription**:
        1. Subscribe `["user", userId]` -> Get list of chats.
        2. Subscribe `["chat", chatId]` -> Get messages for active chat.
    *   **Partial Data**: Client only caches the active chat's messages, not all history for all chats.
*   **Server**:
    *   Accepts transactional commits that may span multiple subspaces.
    *   Applies changes to the respective shared `SyncDb` instances.

### Reducers (Per Subspace)

**User Subspace Reducers** (`["user", userId]`):
```typescript
type UserReducers = {
    joinChat: (chatId: ChatId) => void
    leaveChat: (chatId: ChatId) => void
}
```

**Chat Subspace Reducers** (`["chat", chatId]`):
```typescript
type ChatReducers = {
    postMessage: (msg: Message) => void
    updateTitle: (title: string) => void
}
```

---

## Implementation Plan

1.  **Refine Types**: Update `src/syncDb/examples/types.ts` to match the new simpler architecture.
2.  **Implement Client**: Create a clean `SimpleSyncClient` that focuses on the `sync(path).query(...)` DX.
    *   Must handle `TupleCache` interactions internally.
    *   Must handle optimistic writes and queueing.
3.  **SyncExample1.test.ts**: Re-implement to use the new client DX for the Fan-out case.
4.  **SyncExample2.test.ts**: Re-implement to demonstrate the Waterfall pattern using the new client DX.