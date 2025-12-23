# TupleDB Query Syntax V5: The Pipeline Model

This document defines the V5 query syntax, which moves from a "Type-based" index definition (Record vs Join vs Aggregation) to a **Pipeline-based** definition. This change eliminates ambiguity and strictly defines which queries are valid and physically executable as Materialized Views.

## Core Philosophy: Indexes as Pipelines

In TupleDB, an "Index" is not just a b-tree on a column; it is a **Materialized View** maintained by a dataflow pipeline. Every query defines a pipeline that transforms a stream of database changes into a persisted sorted map (KV Store).

The pipeline has 4 strict stages, which determine the **Scope** (available variables) at each step.

$$ Q = (M, W, R, S) $$

1.  **Match ($M$ - Topology):** Defines the "Virtual Relation" by joining tables.
2.  **Where ($W$ - Filter):** Filters the stream.
3.  **Reduce ($R$ - Shape):** Aggregates or projects data, defining the unique identity of a row.
4.  **Sort ($S$ - Layout):** Defines the physical order on disk.

---

## The Canonical Structure

A query object strictly separates these concerns:

```ts
{
  // 1. TOPOLOGY: The Join Graph
  // Defines the raw variables available (e.g., u, p).
  match: {
    u: { from: "user" },
    p: { from: "post", on: { authorId: "u.id" } }
  },

  // 2. FILTER: Global Constraints
  // Applied to the graph results.
  where: {
    "u.age": { gt: 18 }
  },

  // 3. SHAPE: Reduction & Projection
  // Transforms Scope! Raw variables are consumed and output new variables.
  reduce: {
    groupBy: ["u.id"],
    aggregate: {
      postCount: { count: "p.id" },
      latestPostAt: { max: "p.createdAt" }
    }
  },

  // 4. LAYOUT: Physical Sort Order
  // MUST use variables available after Reduction.
  sort: ["latestPostAt", "u.id"]
}
```

---

## The Golden Rule of Scope

To ensure a query is valid, variables must exist in the current Scope.

1.  **Scope Level 1 (Match Output):**
    *   Contains all fields from all bound variables.
    *   Example: `u.id`, `u.name`, `p.id`, `p.body`.

2.  **Scope Level 2 (Reduce Output):**
    *   **If `reduce` is present:** The scope is **replaced**. It contains ONLY keys from `groupBy` and keys from `aggregate`. All other fields (like `u.name` or `p.body`) are **lost** (crushed into the aggregate).
    *   **If `reduce` is missing:** The scope remains Level 1.

3.  **Scope Level 3 (Sort Input):**
    *   The `sort` array can ONLY reference variables present in Scope Level 2.

---

## Canonical Dogfooding Queries

Refined versions of the V4 queries, adhering to strict V5 syntax.

### 1. Simple Lookup (User by Name)
**Goal:** Find a specific user by their name.
*Scope:* `u.*` matches. No reduce. Sort uses `u.*`.

```ts
{
  match: {
    u: { from: "user" }
  },
  sort: ["u.name", "u.id"]
  // scan: { prefix: ["Chet"] } -> Scan is runtime, not definition.
}
```

### 2. Paged Sort (User by Age)
**Goal:** Get users older than 18, sorted by age.

```ts
{
  match: {
    u: { from: "user" }
  },
  where: {
    "u.age": { gte: 18 }
  },
  sort: ["u.age", "u.id"]
}
```

### 3. Multi-Attribute Lookup (User by Name & Bio)
**Goal:** Lookup on composite fields.

```ts
{
  match: {
    u: { from: "user" }
  },
  sort: ["u.bio", "u.name", "u.id"]
}
```

### 4. Grouping & Counting (Unique Bios)
**Goal:** Count how many users have each specific bio.
*Scope Change:* `u.*` is lost. Only `u.bio` and `userCount` remain.

```ts
{
  match: {
    u: { from: "user" }
  },
  reduce: { 
    groupBy: ["u.bio"],
    aggregate: { 
      userCount: { count: "u.id" } 
    }
  },
  // We sort by the Group Key (Identity)
  sort: ["u.bio"] 
}
```

### 5. Aggregated Sort (Users ordered by Latest Post)
**Goal:** List users, sorted by the timestamp of their most recent post.

```ts
{
  match: {
    u: { from: "user" },
    p: { from: "post", on: { authorId: "u.id" } }
  },
  reduce: { 
    groupBy: ["u.id"],
    aggregate: { 
      latestPostAt: { max: "p.createdAt" } 
    }
  },
  // Sort by the Computed Value, then Tie-breaker
  sort: ["latestPostAt", "u.id"]
}
```

### 6. Follower Feed (Standard Join)
**Goal:** Posts from users I follow, sorted by time.
*Note:* No reduction needed. We want the individual posts.

```ts
{
  match: {
    f: { from: "follow" },
    p: { from: "post", on: { authorId: "f.toId" } }
  },
  // We need to support efficient lookup by "f.fromId" (The viewer)
  sort: ["f.fromId", "p.createdAt", "p.id"]
}
```

### 7. Friends of Friends (Ordered by "Entry into Orbit")
**Goal:** See who my friends are following, sorted by when the connection path was established.

```ts
{
  match: {
    f: { from: "follow" },
    f2: { from: "follow", on: { fromId: "f.toId" } }
  },
  reduce: {
    // Unique Path: Me -> Target. 
    // We collapse multiple intermediate friends if they exist? 
    // Or just treat (Me, Friend, Target) as unique?
    // Let's assume we want unique (Me, Target) pairs.
    groupBy: ["f.fromId", "f2.toId"],
    aggregate: {
      // Logic: The "connection time" is the newest link in the chain (max),
      // If there are multiple paths, we take the strongest/earliest (min)? 
      // V5 specific syntax for nested logic might be needed, or simple MAX.
      connectionTime: { max: "f2.createdAt" } 
    }
  },
  sort: ["f.fromId", "connectionTime", "f2.toId"]
}
```

### 8. Friends of Friends Feed (Deep Join)
**Goal:** Posts by friends of friends.

```ts
{
  match: {
    f: { from: "follow" },
    f2: { from: "follow", on: { fromId: "f.toId" } },
    p: { from: "post", on: { authorId: "f2.toId" } }
  },
  // No reduce: we want every post.
  // Duplicates? If I follow 2 people who follow the same target, 
  // 'p' will appear twice in the join graph. 
  // Without 'reduce', the index will contain both entries (ref counted).
  sort: ["f.fromId", "p.createdAt", "p.id"]
}
```

---

## Invalid Queries (Anti-Patterns)

The pipeline model allows us to mechanically detect invalid queries.

### Invalid 1: Sorting by Lost Data
You cannot sort by a field that was not preserved in the `groupBy`.

```ts
{
  match: { u: { from: "user" }, p: { from: "post" } },
  reduce: {
    groupBy: ["u.id"], // Scope is now ONLY ["u.id", "count"]
    aggregate: { count: { count: "p.id" } }
  },
  // ERROR: "u.name" is not in Scope! 
  // We grouped by ID. The value "u.name" is ambiguous or lost.
  sort: ["u.name", "count"] 
}
```

### Invalid 2: Ambiguous Joins
Joins must be explicit in `match`.

```ts
{
  match: {
    u: { from: "user" },
    // ERROR: Missing 'on' clause. Cartesian product or ambiguous inference?
    // V5 requires explicit 'on' for clarity.
    p: { from: "post" } 
  }
}
```

### Invalid 3: GroupBy vs OrderBy Mismatch
(This is actually **VALID**, just handled specifically)

```ts
{
  // ... match ...
  reduce: {
    groupBy: ["u.id"],
    aggregate: { maxDate: { max: "p.createdAt" } }
  },
  // Valid! We don't HAVE to sort by the group key first.
  // We can sort by the aggregate.
  sort: ["maxDate", "u.id"] 
}
```

---

## Implementation Strategy

1.  **Planner:** The `ensureIndex` function acts as a compiler. It validates the Scope flow.
2.  **Pipeline Construction:**
    *   **Source:** Listen to `u` and `p` tables.
    *   **Join:** When `u` changes, scan `p` index. When `p` changes, scan `u` index.
    *   **Reduce:** Maintain a multiset of `(GroupKey) -> AggregateState`.
    *   **Sort:** Maintain the final KV map `(SortKey) -> RefCount`.
3.  **Storage:** The underlying storage is always a Ref-Counted Multiset.
    *   `+1`: Insert/Increment.
    *   `-1`: Decrement/Delete.
