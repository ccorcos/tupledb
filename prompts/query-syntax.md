# TupleDB Query Syntax Guide

This document defines the query syntax for `RecordLayer`. The goal is to provide a declarative, expressive API that supports complex application needs—ranging from simple lookups to complex graph traversals and aggregations—while remaining performant and type-safe.

## Core Concepts

The query API is designed around three key concepts:
1.  **Declarative Data Fetching:** Describe *what* you want, not *how* to loop.
2.  **Relational & Graph Hybrid:** Support standard joins (1:N) and graph-like traversals (variable binding).
3.  **Composable Pipelines:** Queries can be chained or nested (logically) to allow aggregations over joins.

---

## 1. Basic Queries

The simplest query selects records from a single type (table) with optional filtering and sorting.

### Syntax

```typescript
db.query({
  from: "user",
  where: {
    active: true,
    age: { $gte: 21 },
    role: { $in: ["admin", "editor"] }
  },
  sort: ["createdAt"], // Default ASC. Use { field: "desc" } for reverse.
  limit: 20
})
```

### Operators

*   **Equality:** `{ key: value }` (Implicit equality)
*   **Comparison:** `$gt`, `$gte`, `$lt`, `$lte`, `$ne`
*   **Set:** `$in`, `$nin`
*   **Logical:** `$and`, `$or`, `$not` (Top-level or nested)

---

## 2. Joins & Graph Traversals

To join data, we use a **variable binding** syntax similar to Datalog or logic programming. This allows you to define relationships clearly without complex nesting of `left/right` objects.

### Concept

You define a set of **sources** in the `from` block. Each source acts as a variable that can be referenced by subsequent sources.

### Example: "Posts by users I follow" (Social Feed)

```typescript
db.query({
  select: {
    // Define the shape of the output result
    post: "$post",
    author: "$friend"
  },
  from: {
    // 1. Start with 'me'
    me: { from: "user", where: { id: "current_user_id" } },

    // 2. Find who 'me' follows. Bind results to '$follow'.
    //    $me.id is available from the previous step.
    follow: { from: "follow", where: { fromId: "$me.id" } },

    // 3. Find the user record for the friend (optional, if we need their name)
    friend: { from: "user", where: { id: "$follow.toId" } },

    // 4. Find posts authored by that friend
    post: { from: "post", where: { authorId: "$friend.id" } }
  },
  // Filter the final results
  where: {
    "$post.published": true
  },
  sort: ["$post.createdAt"], // Sort by post time
  reverse: true,
  limit: 50
})
```

### Example: "Friends of Friends" (2nd Degree Network)

```typescript
db.query({
  select: "$fof", // Shorthand to return the whole record from the 'fof' variable
  from: {
    // 1. My follows
    myEdge: { from: "follow", where: { fromId: "me" } },
    
    // 2. Their follows (The join happens here via $myEdge.toId)
    theirEdge: { from: "follow", where: { fromId: "$myEdge.toId" } },
    
    // 3. The actual person (2nd degree connection)
    fof: { from: "user", where: { id: "$theirEdge.toId" } }
  }
})
```

---

## 3. Aggregation & Grouping

Aggregations allow you to summarize data, distinct records, or compute statistics. This is essential for feeds where multiple paths might lead to the same result (e.g., I might follow two people who both follow "Person C"—I only want to see "Person C" once).

### Syntax

*   **groupBy:** Fields to group by.
*   **aggregate:** Map of output fields to aggregation functions (`count`, `sum`, `min`, `max`, `first`, `last`).

### Example: Unique Friends of Friends (Ordered by "Earliest Connection")

Use Case: "People you might know", ordered by how long ago the connection path was established.

```typescript
db.query({
  from: {
    myEdge: { from: "follow", where: { fromId: "me" } },
    theirEdge: { from: "follow", where: { fromId: "$myEdge.toId" } },
    candidate: { from: "user", where: { id: "$theirEdge.toId" } }
  },
  // We only want candidates I don't already follow
  where: {
    "$candidate.id": { $nin: "$known_ids" } // Assume we pass existing friends or filter via sub-query (future)
  },
  groupBy: ["$candidate.id"],
  aggregate: {
    user: { first: "$candidate" }, // Pick the user object
    earliestPath: { min: "$myEdge.datetime" }, // The oldest connection in the chain
    mutualCount: { count: true } // How many mutual friends?
  },
  sort: ["earliestPath", "mutualCount"],
  limit: 20
})
```

### Example: Unread Message Count (Chat App)

```typescript
db.query({
  from: {
    conversation: { from: "conversation", where: { memberIds: "me" } },
    message: { from: "message", where: { conversationId: "$conversation.id" } }
  },
  where: {
    "$message.status": "unread",
    "$message.senderId": { $ne: "me" }
  },
  groupBy: ["$conversation.id"],
  aggregate: {
    convId: { first: "$conversation.id" },
    unreadCount: { count: true },
    lastMessage: { max: "$message.createdAt" }
  }
})
```

---

## 4. Range Scanning & Pagination

Efficient pagination is critical for UI performance.

### Cursor-Based Pagination (`startAfter`)

Instead of `offset`, which becomes slow, use `startAfter`. The value passed to `startAfter` should be the **sort key** of the last item from the previous page.

```typescript
// Page 1
const results = db.query({
  from: "post",
  sort: ["createdAt", "id"], // Always include ID for deterministic ties
  limit: 10
})

const lastItem = results[results.length - 1]
const cursor = {
    createdAt: lastItem.createdAt,
    id: lastItem.id
}

// Page 2
const nextResults = db.query({
  from: "post",
  sort: ["createdAt", "id"],
  startAfter: cursor, // Resume exactly after the last item
  limit: 10
})
```

### Specific Range Scans

You can scan a specific slice of an index efficiently.

```typescript
db.query({
  from: "log_entry",
  where: {
    severity: "error",
    timestamp: {
        $gte: "2023-01-01T00:00:00Z",
        $lt:  "2023-01-02T00:00:00Z"
    }
  },
  // The system will select the index [severity, timestamp] automatically.
  // It will seek to "error", "2023..." and stop at "error", "2023-01-02..."
})
```

---

## 5. Realistic Examples

### A. Group Messaging App

**Requirements:**
1.  List channels the user is in.
2.  For each channel, show the name and the *latest message preview*.
3.  Sort by latest message activity.

```typescript
db.query({
  from: {
    // 1. My memberships
    membership: { from: "channel_member", where: { userId: "me" } },
    
    // 2. The channel details
    channel: { from: "channel", where: { id: "$membership.channelId" } },
    
    // 3. Messages in those channels
    message: { from: "message", where: { channelId: "$channel.id" } }
  },
  groupBy: ["$channel.id"],
  aggregate: {
    channelInfo: { first: "$channel" },
    lastMessageBody: { last: "$message.body" }, // "last" implies max sort key (time)
    lastActive: { max: "$message.createdAt" }
  },
  sort: [{ lastActive: "desc" }],
  limit: 50
})
```

### B. Calendar App

**Requirements:**
1.  Show events for a specific week.
2.  Include events that *span across* the week (start before, end after).

```typescript
const weekStart = "2023-10-01";
const weekEnd = "2023-10-08";

db.query({
  from: "event",
  where: {
    $or: [
      // Starts within the week
      { start: { $gte: weekStart, $lt: weekEnd } },
      // Ends within the week
      { end: { $gte: weekStart, $lt: weekEnd } },
      // Spans over the week (Starts before AND Ends after)
      { 
        start: { $lt: weekStart },
        end: { $gte: weekEnd }
      }
    ]
  },
  sort: ["start"]
})
```
*Note: Optimization of `$or` ranges depends on multiple index scans merged together.*

### C. Email Inbox

**Requirements:**
1.  Show threads in "Inbox".
2.  Sort by date of the *most recent message* in the thread.
3.  Paging.

```typescript
db.query({
  from: {
    thread: { from: "thread", where: { folder: "inbox", owner: "me" } },
    msg: { from: "email", where: { threadId: "$thread.id" } }
  },
  groupBy: ["$thread.id"],
  aggregate: {
    subject: { first: "$thread.subject" },
    snippet: { last: "$msg.snippet" }, // Last msg snippet
    lastUpdate: { max: "$msg.receivedAt" }
  },
  sort: [{ lastUpdate: "desc" }],
  limit: 20
})
```
