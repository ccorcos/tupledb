# TupleDB Query Syntax V4 & Dogfooding Suite

This document iterates on V3, refining the syntax (removing `$` prefixes) and establishing a canonical list of queries for dogfooding and testing. It serves as both a functional specification and a developer experience guide.

## Core Concepts

A query in TupleDB defines a **Materialized View** and a **Scan Strategy** over that view.

$$ Q = (G, C, K, R) $$

1.  **Graph ($G$ - `match`):** Defines the set of joined records and variable bindings.
2.  **Constraints ($C$ - `where`):** Filters the relations.
3.  **Key/Projection ($K$ - `index`):** Defines the **Physical Sort Order** of the output.
4.  **Reduction ($R$ - `reduce`/`groupBy`):** Defines how to aggregate data when multiple paths map to the same key.

### API Usage Note

*   `query()` returns a list of **index keys** and **values** (values are reference counts or aggregation results).
*   `get()` is then used to fetch the actual object data using IDs found in the index keys, if needed.

---

## Variable Disambiguation

*Current Convention:*
*   Keys in `match` objects define **Variable Names** (e.g., `u`, `p`).
*   Strings in `where`, `index`, and `reduce` that start with a known variable name are treated as **References** (e.g., `"u.name"`).
*   *Open Question:* How to strictly disambiguate a literal string "u.name" from the reference `u.name`?
    *   *Proposal:* We could assume strings are literals unless wrapped in a helper, OR assume strings matching `[var].[prop]` are refs.
    *   *For V4:* We follow the examples below where direct strings like `"f.toId"` represent variables if `f` is bound.

---

## Canonical Dogfooding Queries

These queries cover the primary access patterns we need to support.

### 1. Simple Lookup (User by Name)
**Goal:** Find a specific user by their name.

```ts
{
  match: {
    u: { from: "user" }
  },
  index: ["u.name", "u.id"],
  scan: { prefix: ["Chet"] }
}
```

### 2. Paged Sort (User by Age)
**Goal:** Get users older than 18, sorted by age, page size 20.

```ts
{
  match: {
    u: { from: "user" }
  },
  index: ["u.age", "u.id"],
  scan: { gte: [18], limit: 20 }
}
```

### 3. Multi-Attribute Lookup (User by Name & Bio)
**Goal:** Lookup on composite fields.

```ts
{
  match: {
    u: { from: "user" }
  },
  index: ["u.bio", "u.name", "u.id"]
}
```

### 4. Grouping & Counting (Unique Bios)
**Goal:** Count how many users have each specific bio.

```ts
{
  match: {
    u: { from: "user" }
  },
  groupBy: ["u.bio"],
  reduce: { 
    byName: { count: "u.name" } 
  }
}
```
*   **Note on `groupBy`**: Here, `groupBy` acts as the primary key for the aggregation. The output keys will be `[ "some bio string" ]` and the value will be the count.

### 5. Aggregated Sort (Users ordered by Latest Post)
**Goal:** List users, sorted by the timestamp of their most recent post.

```ts
{
  match: {
    p: { from: "post" }
  },
  groupBy: ["p.authorId"],
  reduce: { 
    latestPostAt: { max: "p.createdAt" } 
  },
  index: ["latestPostAt", "p.authorId"]
}
```
*   **Mechanism**:
    1.  `match`: Find all posts `p`.
    2.  `groupBy`: Collapse all posts by the same author into one row.
    3.  `reduce`: For each group (author), calculate the `max` of `createdAt`. This creates a synthetic variable `latestPostAt` available for the index.
    4.  `index`: Sort the resulting groups by this computed value.

### 6. Follower Feed (Standard Join)
**Goal:** Posts from users I follow, sorted by time.

```ts
{
  match: {
    f: { from: "follow" },
    p: { from: "post", where: { authorId: "f.toId" } }
  },
  index: ["f.fromId", "p.createdAt", "p.id"]
}
```
*   **Variables**: `f.toId` in the `where` clause binds the post's author to the follow's target.
*   **Result**: The index key starts with `f.fromId` (the viewer). Scanning `prefix: ["myUserId"]` gives my feed.

### 7. Friends of Friends (Ordered by "Entry into Orbit")
**Goal:** See who my friends are following, sorted by when the *connection* (either my friendship or their friendship) was most recently established.

```ts
{
  match: {
    f: { from: "follow" },
    f2: { from: "follow", where: { fromId: "f.toId" } }
  },
  groupBy: ["f.fromId", "f2.toId"],
  reduce: {
    // "Min of Max": The path exists as long as BOTH edges exist. 
    // The "age" of the path is the YOUNGEST (Max) timestamp of the two edges.
    // If multiple paths connect me to the same person, we might want the oldest or newest connection.
    // Here: 'min' implies we pick the "strongest" (earliest established?) path if multiple exist? 
    // Or perhaps simply determining order for the view.
    order: { min: { max: ["f2.createdAt", "f.createdAt"] } }
  },
  index: ["f.fromId", "order", "f2.toId"],
  scan: { prefix: ["myUserId"], limit: 10 }
}
```

### 8. Friends of Friends Feed (Deep Join)
**Goal:** Posts by friends of friends.

```ts
{
  match: {
    f: { from: "follow" },
    f2: { from: "follow", where: { fromId: "f.toId" } },
    p: { from: "post", where: { authorId: "f2.toId" } }
  },
  index: ["f.fromId", "p.createdAt", "p.id"]
}
```
*   **Uniqueness**: Since we index on `p.id` at the leaf, the posts are inherently unique rows in the index, even if reached via multiple paths (though they would appear multiple times if the *prefix* keys differ, e.g. if `f.fromId` was not the root). Here, for a single viewer (`f.fromId`), a post appears once unless the join graph produces duplicates. If I follow two people who follow the *same* third person, `p` would be matched twice. 
    *   *Correction*: Without `groupBy`, this query *would* return the same post multiple times if multiple paths lead to it. To deduplicate, we rely on the IVM's reference counting or explicit `groupBy`. If the index key is identical (e.g. `[me, time, postID]`), the underlying KV store might treat it as one entry with ref-count 2.

---

## Syntax Discussion: Variables vs. Literals

In V4, we aim to remove the `$` prefix for cleaner syntax.

**Ambiguity Problem:**
`where: { status: "u.status" }`
Is `"u.status"` the literal string "u.status" or the value of field `status` on variable `u`?

**Proposed Rules:**
1.  **Schema Awareness (Ideal):** If `u` is a bound variable and has property `status`, it's a reference. This is fragile if schema evolves.
2.  **Explicit Binding:**
    *   `where: { status: ref("u.status") }` for references.
    *   `where: { status: "active" }` for literals.
3.  **Convention:** Strings containing `.` where the prefix matches a scope variable are references. All others are literals. (Current examples imply this).

**Variable Declaration:**
We do not explicitly declare variables. They are implicitly declared as the keys in the `match` object.

```ts
match: {
  userVar: { from: "user" } // 'userVar' is now a variable
}
```
