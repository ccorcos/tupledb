# TupleDB Query Syntax V2: Explicit & Structural

This proposal shifts the focus from "Magic SQL-like" queries to **Structural Definitions**. The developer explicitly defines the graph pattern (`match`), the resulting tuple structure (`index`), and the slice of that index to read (`scan`). 

This approach removes ambiguity regarding sorting, scanning, and index usage. It treats queries as definitions of **Materialized Views** or **Index Scans**.

---

## 1. The Core Philosophy

1.  **Pattern Matching (`match`):** Define the graph of records and their relationships using variable bindings.
2.  **Explicit Indexing (`index`):** Define the exact Tuple structure that results from the match. This corresponds 1:1 with the underlying storage key.
3.  **Tuple Scanning (`scan`):** Define the bounds (`gt`, `lt`, `prefix`) using tuple values, not opaque cursors.
4.  **Deterministic Reduction (`reduce`):** Use explicit operators for aggregation to avoid "first/last" ambiguity.

---

## 2. Structural Query Examples

### A. Friend-of-Friend Feed (Complex Join & Uniqueness)

**Goal:** A timeline of posts from people my friends follow.
**Constraint:** If I follow two people who both follow "User C", "User C's" post should appear only once (Reference Counting).

```typescript
db.query({
  // 1. Define the Data Graph
  match: {
    me: { from: "user", where: { id: "my_id" } },
    
    // My follows (Level 1)
    l1: { from: "follow", where: { fromId: "$me.id" } },
    
    // Their follows (Level 2 - Friends of Friends)
    l2: { from: "follow", where: { fromId: "$l1.toId" } },
    
    // The Post created by the FoF
    post: { from: "post", where: { authorId: "$l2.toId" } }
  },

  // 2. Define the "View" Key (The Index)
  // This explicitly sets the sort order. 
  // Since $l1 and $l2 (the path) are NOT in the index, 
  // multiple paths to the same $post will collide.
  // The system handles this via Reference Counting on the value.
  index: ["$me.id", "$post.createdAt", "$post.id"],

  // 3. Scan the View
  scan: {
    // We lock the first part of the tuple to "my_id"
    prefix: ["my_id"],
    
    // Paging: "Give me posts after this specific timestamp+id"
    // This is explicitly asking for the tuple range > [last_created_at, last_id]
    gt: ["2023-11-01T12:00:00Z", "post_999"],
    
    limit: 50
  },

  // 4. Projection
  select: {
    id: "$post.id",
    body: "$post.body",
    author: "$post.authorId",
    createdAt: "$post.createdAt"
  }
})
```

**Why this is better:**
*   **No "Magic" Sort:** You can't sort by something you didn't put in the `index`.
*   **Explicit Uniqueness:** By excluding the "path" variables (`l1`, `l2`) from the `index`, you explicitly request a set-union (deduplicated) view. If you wanted to see duplicates (one for each path), you would add `$l1.id` to the `index`.
*   **Resumable:** The `scan.gt` arguments are derived directly from the last row of the previous result.

### B. Aggregation: Designer Counts

**Goal:** Count number of designers grouped by their name.

```typescript
db.query({
  match: {
    u: { from: "user", where: { bio: "Designer" } }
  },
  
  // Grouping is implicit in the index structure for aggregations.
  // Keys before the aggregation boundary are the "Group By" keys.
  groupBy: ["$u.name"],
  
  reduce: {
    count: "count", // Short for { op: "count" }
  }
})
// Output: [{ key: ["Alice"], count: 4 }, { key: ["Bob"], count: 1 }]
```

### C. Aggregation: Summing Experience

**Goal:** Sum the age of all designers.

```typescript
db.query({
  match: {
    u: { from: "user", where: { bio: "Designer" } }
  },
  
  // No groupBy implies global aggregation over the matched set
  reduce: {
    totalAge: { sum: "$u.age" }
  }
})
// Output: { totalAge: 90 }
```

### D. "ArgMax": Getting the Best Item per Group

**Goal:** For each category, get the *item* with the highest price.
**Ambiguity Fix:** Instead of `first`/`last`, we use `max` on the value, but if we want the *record* associated with that max, we use `pick` with a deterministic sort.

```typescript
db.query({
  match: {
    item: { from: "item" }
  },
  
  groupBy: ["$item.category"],
  
  reduce: {
    // "Pick the item record where price is Max"
    mostExpensive: { 
      pick: "$item", 
      by: { field: "$item.price", dir: "desc" } 
    },
    // Standard stat
    highestPrice: { max: "$item.price" }
  }
})
```

---

## 3. Tuple Layout & Scan Syntax Details

### The `index` Array
The `index` array defines the physical order of data. It supports:
*   **Variables:** `"$user.id"`
*   **Constants:** `"TYPE_PREFIX"` (useful for discriminating unions in single-table designs)
*   **Directions:** (Future) `{ val: "$post.createdAt", dir: "desc" }` (if the DB supports mixed-order encoding).

### The `scan` Object
Directly maps to `TupleDb` range operations.

*   `prefix`: `Tuple`. Matches items starting with this tuple.
*   `gt`: `Tuple`. Strictly greater than.
*   `gte`: `Tuple`. Greater than or equal.
*   `lt`: `Tuple`. Strictly less than.
*   `lte`: `Tuple`. Less than or equal.
*   `limit`: `number`.

**Example: Time-Window Pagination**

Index: `["$user.id", "$log.timestamp"]`

```typescript
// Initial Load (Latest 20)
scan: {
  prefix: ["user_123"],
  reverse: true,
  limit: 20
}
// Returns timestamps [T100 ... T81]

// Next Page (Older than T81)
scan: {
  prefix: ["user_123"],
  lt: ["T81"], // Explicit tuple cut-off
  reverse: true,
  limit: 20
}
```

---

## 4. Solving the "Uniqueness" Problem

When a `match` clause creates a fan-out (e.g., 1 User -> 100 Friends -> 5000 Posts), we have intermediate rows.

If the `index` key is `["$me.id", "$post.id"]`, the engine sees multiple intermediate rows mapping to the same index key.

*   **Write Time:** 
    *   Row 1: `Me -> FriendA -> Post1` => Key: `[Me, Post1]`.
    *   Row 2: `Me -> FriendB -> Post1` => Key: `[Me, Post1]`.
*   **Ref Counting:** 
    *   The database stores `Key: [Me, Post1] -> Value: 2` (Ref count).
*   **Read Time:** 
    *   The scanner sees `[Me, Post1]`. It ignores the value (ref count) unless explicitly asked for.
    *   It returns **one** instance of `Post1`.

This provides the "Unique" behavior by default for these views.

---

## 5. Comparison with V1

| Feature | V1 (Mongo-lite) | V2 (Structural) |
| :--- | :--- | :--- |
| **Joins** | Nested `left`/`right` objects | Flat `match` map with variables |
| **Sorting** | `sort: ["field"]` (Magic) | `index: ["$var.field", ...]` (Explicit) |
| **Pagination** | `offset` or opaque `cursor` | Explicit Tuple `gt`/`lt` |
| **Ambiguity** | "First/Last" depends on scan | `pick` requires `by` sort def |
| **Uniqueness** | Implicit/Magic | Defined by `index` keys (Ref Counting) |

V2 is more verbose but eliminates the class of bugs where the query implies an index that doesn't exist or a sort order that is impossible to execute efficiently.
