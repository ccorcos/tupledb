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

## Example 1: Fan-out Architecture

In this model, every user has their own isolated `SyncDb` subspace. The server is responsible for distributing updates to all relevant users.

### Architecture

*   **Client**:
    *   Connects to a single `SyncDb` subspace: `["user", userId]`.
    *   Subscribes to `["data"]` for all updates.
    *   Submits actions (Intent) to the server, which are then processed and fanned out.
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

### Server Logic (Pseudo-code)

```typescript
function handleSendMessage(senderId, chatId, body) {
    const members = getChatMembers(chatId)
    const message = { id: randomId(), chatId, fromId: senderId, body, ... }

    for (const memberId of members) {
        // Write to each member's isolated syncDb
        const memberDb = getSyncDb(["user", memberId])
        memberDb.write(ops => ops.putMessage(message))
    }
}
```

---

## Example 2: Normalized / Multi-Subspace Architecture

In this model, data is stored in shared subspaces (e.g., a specific Chatroom). Clients subscribe to multiple `SyncDb` instances.

### Architecture

*   **Client**:
    *   Subscribes to `["user", userId]` for private data (list of chats).
    *   Subscribes to `["chat", chatId]` for each active chatroom.
    *   Subscribes to `["profiles"]` (global or sharded) for user profiles.
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

**Profile Subspace Reducers** (`["profiles"]`):
```typescript
type ProfileReducers = {
    updateProfile: (profile: UserProfile) => void
}
```

### Client Transaction Logic

The client needs to be able to bundle operations targeting different logical databases.

```typescript
// Client-side transaction
client.write(ops => {
    // Op 1: Add chat to user's list
    ops.scope(["user", myId]).joinChat(chatId)

    // Op 2: Post initial message to the chat subspace
    ops.scope(["chat", chatId]).postMessage(helloMsg)
})
```

---

## Implementation Plan

1.  **Define Types**: Create `src/syncDb/examples/types.ts` (or similar) to hold the shared domain models and reducer definitions.
2.  **Mock Network**: Create a `SimulatedNetwork` class to connect `SyncClient` and `SyncServer` with controlled latency/reliability (optional, but good for tests).
3.  **SyncExample1.test.ts**:
    *   Setup `SyncServer`.
    *   Implement "Fan-out" logic on the server `write` handler.
    *   Instantiate `SyncClient` for User A and User B.
    *   User A sends message -> Server fans out -> User B sees message in their `data`.
4.  **SyncExample2.test.ts**:
    *   Setup `SyncServer`.
    *   Implement "Multi-scope" write handling.
    *   Instantiate `SyncClient`.
    *   Demonstrate subscribing to `UserDb` to discover `ChatDb`.
    *   Demonstrate cross-db write (Join Chat + Post Message).

## Future: RecordDb Integration

*   Replace raw `tupleDb.set` calls in reducers with `RecordLayer` operations (e.g., `Users.insert(user)`).
*   Use `RecordLayer`'s IVM (Incremental View Maintenance) to automatically maintain indexes (e.g., `Messages.byDate`).

---

This looks great. However the clients should be using the TupleCache at the very least. Clients are not fully replicated but only partially replicated. Its the developers responsibility to ensure that reducers will lead to eventual consistency when applying to a partially available database. And for simple sets and deletes, this should mostly be the case. It seems that SyncCache and SyncClient attempt to fill some of this functionality. However, it seems to be incomplete / the abstractions feel a little too belabored. So please incorporate those changes into these examples as well as the plan document so that we aren't fully replicating the database to the clients. And to make the examples a little more realistic, consider on the client what it would look like to query for data, checking the cache before going to the server to request the data, render that data, and listen for changes. You can include a single waterfall request example too, fetch the user and then fetch the chatrooms etc. Do this all with clean abstactions and test the whole flow within the examples.


