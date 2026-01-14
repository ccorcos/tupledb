# TupleDB Query Taxonomy & V3 Surface Area

This document defines a systematic approach to "thinking about queries" for TupleDB IVM. It breaks down the query space into fundamental dimensions and provides a comprehensive set of examples covering the "surface area" of possibilities.

## 1. The Systematic Model (The "Query Calculus")

To ensure we cover "anything we want," we define a query not as a magic object, but as a pipeline of four distinct operations. A "Query" is the definition of a **Materialized View** and a **Scan Strategy** over that view.

$$ Q = (G, C, K, R) $$

1.  **Graph ($G$ - `match`):** Defines the set of joined records and variable bindings. This produces a "Raw Relation" (a set of tuples of records).
    *   *Complexity:* Linear, Star, Diamond, Cyclic.
2.  **Constraints ($C$ - `where`):** Filters the Raw Relation before indexing.
    *   *Complexity:* Equality, Range, Set ($in), Logic ($and/$or).
3.  **Key/Projection ($K$ - `index`):** Defines the **Physical Sort Order** and **Uniqueness** scope. This maps the Raw Relation to a Key-Value pair in the KV store.
    *   *Complexity:* Root props, Leaf props, Computed, Mixed Directions.
4.  **Reduction ($R$ - `reduce`/`aggregate`):** Defines how to handle collisions in $K$.
    *   *Default:* Reference Counting (Set Union behavior).
    *   *Explicit:* Sum, Count, Min, Max, First/Last (ArgMin/ArgMax).

---

## 2. The Dimensions of Complexity (The Matrix)

We generate examples by traversing these dimensions:

### Dimension A: Graph Topology
1.  **Atom:** Single Node (Select * from User).
2.  **Path (1:N):** User -> Posts.
3.  **Reverse Path (N:1):** Post -> User.
4.  **Chain (Deep):** User -> Follow -> User -> Post.
5.  **Star (Fan-out):** Post -> Tags, Post -> Comments.
6.  **Diamond (Multi-path):** User -> Group -> Member, User -> Friend -> Member.

### Dimension B: Index Sort Key
1.  **PK:** Sorted by ID.
2.  **Local Attribute:** Sorted by local field (User.name).
3.  **Foreign Attribute:** Sorted by joined field (User sorted by Post.date? - *Implies Duplication*).
4.  **Compound:** Sorted by Local then Foreign.

### Dimension C: Cardinality & Uniqueness
1.  **Unique:** 1:1 map.
2.  **Multi-Value:** 1:N (User appears multiple times, once per Post).
3.  **Deduplicated:** N:1 (Posts by Friends - Post appears once even if followed by 2 friends).

### Dimension D: Constraints (Filter)
1.  **Static:** `status = 'active'`
2.  **Dynamic:** `date > $now` (Requires periodic re-indexing or scan-time filter).
3.  **Correlated:** `post.date > user.lastLogin`.

---

## 3. The Comprehensive Query Suite

Below is a structured list of queries covering the surface area.

### Group 1: Atomic Queries (Single Source)

**1.1 Simple PK Lookup**
*Goal:* Get user by ID.
```javascript
{
  match: { u: { from: "user" } },
  index: ["$u.id"], // Primary Index
  scan: { prefix: ["u_123"] }
}
```

**1.2 Attribute Sort**
*Goal:* Users by Name.
```javascript
{
  match: { u: { from: "user" } },
  index: ["$u.name", "$u.id"], // Include ID for determinism
  scan: { prefix: [] }
}
```

**1.3 Static Filter**
*Goal:* Active Users by Name.
```javascript
{
  match: { u: { from: "user", where: { status: "active" } } },
  index: ["$u.name", "$u.id"],
  scan: { prefix: [] }
}
```

**1.4 Compound Sort**
*Goal:* Users by Region, then Age.
```javascript
{
  match: { u: { from: "user" } },
  index: ["$u.region", "$u.age", "$u.id"],
  scan: { prefix: ["US"] } // Users in US, sorted by Age
}
```

### Group 2: Path Joins (1:N & N:1)

**2.1 Parent -> Child (Timeline)**
*Goal:* All posts by a specific user, sorted by time.
```javascript
{
  match: {
    u: { from: "user", where: { id: "u_1" } }, // Constrained root
    p: { from: "post", where: { authorId: "$u.id" } }
  },
  index: ["$u.id", "$p.createdAt", "$p.id"],
  scan: { prefix: ["u_1"] }
}
```

**2.2 Child -> Parent (Enrichment)**
*Goal:* Posts with Author details, sorted by Post time.
```javascript
{
  match: {
    p: { from: "post" },
    u: { from: "user", where: { id: "$p.authorId" } }
  },
  index: ["$p.createdAt", "$p.id"], // Sort by Child property
  select: { post: "$p", author: "$u" } // Return joined data
}
```

**2.3 "Aggregated Sort" (The Hard Case)**
*Goal:* Users sorted by the *date of their latest post*.
*Note:* This requires grouping/aggregation.
```javascript
{
  match: {
    u: { from: "user" },
    p: { from: "post", where: { authorId: "$u.id" } }
  },
  groupBy: ["$u.id"],
  reduce: {
    lastPostDate: { max: "$p.createdAt" }
  },
  index: ["$lastPostDate", "$u.id"] // Sort by the aggregated value
}
```

### Group 3: Chain & Graph (Deep Joins)

**3.1 Social Feed (Fan-in / Deduplication)**
*Goal:* Posts from people I follow.
*Constraint:* Ref-counting needed (If I follow A and B, and both follow C, don't show C's post twice?). Actually, this is usually "Posts authored by followees".
```javascript
{
  match: {
    me: { from: "user", where: { id: "my_id" } },
    f: { from: "follow", where: { fromId: "$me.id" } },
    p: { from: "post", where: { authorId: "$f.toId" } }
  },
  // Key excludes the path ($f), so we deduplicate specific posts
  index: ["$me.id", "$p.createdAt", "$p.id"],
  scan: { prefix: ["my_id"] }
}
```

**3.2 Friends of Friends (2-Hop)**
*Goal:* Users who follow my friends.
```javascript
{
  match: {
    me: { from: "user", where: { id: "my_id" } },
    f1: { from: "follow", where: { fromId: "$me.id" } },
    f2: { from: "follow", where: { fromId: "$f1.toId" } }, // f2 is the "Friend of Friend" edge
    u: { from: "user", where: { id: "$f2.toId" } } // The actual person
  },
  index: ["$me.id", "$u.name", "$u.id"],
  scan: { prefix: ["my_id"] }
}
```

### Group 4: Star Topology (Fan-Out)

**4.1 Tag Search (Inverted Index)**
*Goal:* Posts containing a specific tag.
```javascript
{
  match: {
    p: { from: "post" },
    t: { from: "tag", where: { postId: "$p.id" } } // Assuming 1:N normalized tags
  },
  index: ["$t.name", "$p.createdAt", "$p.id"], // Index by Tag
  scan: { prefix: ["basketball"] }
}
```

**4.2 Faceted Search (Multi-attribute)**
*Goal:* Items matching Color=Red AND Size=Large.
*Approach:* Intersection of streams or multi-key index.
```javascript
{
  match: {
    i: { from: "item", where: { color: "red", size: "large" } }
  },
  index: ["$i.price", "$i.id"],
  scan: { prefix: [] }
}
```
*Note:* If attributes are dynamic (EAV), this requires a Join-based intersection which is complex.

### Group 5: Aggregations

**5.1 Global Counts**
*Goal:* Count of all users.
```javascript
{
  match: { u: { from: "user" } },
  groupBy: [], // Global
  reduce: { total: { count: true } }
}
```

**5.2 Bucket Counts (Histograms)**
*Goal:* Count users by Role.
```javascript
{
  match: { u: { from: "user" } },
  groupBy: ["$u.role"],
  reduce: { count: { count: true } }
}
```

**5.3 Top-K per Group (ArgMax)**
*Goal:* The most popular post for each user.
```javascript
{
  match: {
    u: { from: "user" },
    p: { from: "post", where: { authorId: "$u.id" } }
  },
  groupBy: ["$u.id"],
  reduce: {
    topPost: { pick: "$p", by: { field: "$p.likes", dir: "desc" } }
  }
}
```

### Group 6: Disjunctions (Unions)

**6.1 Logic OR**
*Goal:* Posts that are either "High Priority" OR "Tagged 'Urgent'".
*Challenge:* Single index cannot sort effectively by two disparate conditions.
*Solution:* Union-Scan (Scan Index A + Scan Index B, merge in memory).
```javascript
{
  match: {
    p: { from: "post", where: { $or: [{ priority: "high" }, { tag: "urgent" }] } }
  },
  // Requires engine to split into two index scans?
  // Or explicitly defined as two queries merged by client?
  index: ["$p.id"] 
}
```

### Group 7: Negation / Exclusion (The "Anti-Join")

**7.1 Not Exists**
*Goal:* Users who *do not* have a profile picture.
```javascript
{
  match: {
    u: { from: "user", where: { profilePic: null } }
  }
}
```

**7.2 Set Exclusion**
*Goal:* Users I *do not* follow.
*Constraint:* This is massive (N^2). IVM usually handles "Positive" assertions. 
*Workaround:* This is typically a "Scan All Users" minus "Scan My Follows" (Client-side or Query-time subtraction, not indexed).

### Group 8: Calculated Aggregations (Scalar + Aggregate)

**8.1 First Network Appearance (Min-Max Sort)**
*Goal:* Friends of Friends, sorted by when the connection path was *completed*.
*Logic:* A path A->B->C is complete at `MAX(time_AB, time_BC)`. If multiple paths exist, sort by `MIN(path_completion_time)`.
```javascript
{
  match: {
    me: { from: "user", where: { id: "my_id" } },
    l1: { from: "follow", where: { fromId: "$me.id" } },
    l2: { from: "follow", where: { fromId: "$l1.toId" } },
    fof: { from: "user", where: { id: "$l2.toId" } }
  },
  groupBy: ["$me.id", "$fof.id"],
  reduce: {
    // "Min of Max": Find the earliest time a path was completed
    firstConnectedAt: { min: { $max: ["$l1.createdAt", "$l2.createdAt"] } }
  },
  index: ["$me.id", "$firstConnectedAt", "$fof.id"]
}
```

---

## 4. Implementation Checklist for V3

To support the above surface area, the engine must handle:

1.  **Topological Sort of Matches:** The order of `match` keys in the object doesn't matter; the engine must resolve dependencies ($u.id needed for $p).
2.  **Transitive Closures:** Propagating deletes through chains. If `User A` is deleted, `Follow A->B` is deleted, `Post by B` (in the feed) must be removed.
3.  **Ref Counting:** The "Social Feed" example relies on reference counting. If I follow 2 people who repost X, X has RefCount=2. If I unfollow one, X has RefCount=1 (still visible). If I unfollow both, X is gone.
4.  **Value-Based Keys:** Indexes like `["$p.createdAt"]` must handle changes. If a post date changes, the old key must be deleted and new key inserted.
