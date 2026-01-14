# Query Layer Design and Improvements

This document outlines the plan for enhancing the `Query` capabilities in `RecordLayer`. The goal is to move from a simple key-value/range lookup system to a more expressive, declarative query language capable of complex filtering, logical operations, and graph-like joins.

## 1. Comparisons and Filtering

### Current State
Currently, `where` clauses support direct equality checks. Range queries are limited to what `TupleDb` allows (lexicographical) but not exposed via a standard comparison syntax in `RecordLayer`.

### Proposal
Adopt a MongoDB-like syntax for comparison operators.

```ts
db.query({
  from: "post",
  where: {
    author: "1234",
    datetime: { $gte: "2023-01-01", $lte: "2023-12-31" },
    status: { $ne: "draft" },
    tags: { $in: ["news", "update"] } // Requires array handling or repeated queries
  }
})
```

**Supported Operators:**
- `$eq`, `$ne` (Equal, Not Equal)
- `$gt`, `$gte` (Greater than, Greater or Equal)
- `$lt`, `$lte` (Less than, Less or Equal)
- `$in`, `$nin` (In array, Not in array)

### Implementation Challenges & Solutions

#### Compound Indexes & Range Queries
**Challenge:** B-Tree/Tuple indexes work best with equality on prefixes followed by a generic range on *one* field.
`where: { a: 1, b: { $gt: 5 } }` is efficient on index `[a, b]`.
`where: { a: { $gt: 1 }, b: { $gt: 5 } }` is inefficient on index `[a, b]` because `a > 1` splits the search space, and `b` is only sorted locally within each `a`.

**Solution:**
1.  **Constraint:** Allow complex ranges only on the *last* field of a compound index usage.
2.  **Memory Filtering:** If an index covers some fields but not others (or multiple ranges), use the index for the most selective part and filter the rest in memory.
3.  **Skip Scan (Advanced):** Future optimization for some patterns.

#### Mixed Sort Directions
**Challenge:** `sort: [{a: "asc"}, {b: "desc"}]`.
Standard Tuple encoding preserves sort order of components. `[1, 10]` < `[1, 20]`.
If we want `b` descending, we expect `[1, 20]` to come before `[1, 10]`.

**Solution:**
We need to support "Transformations" or "Encoding" in the schema definition or index definition.
- **Inverted Encoding:** When storing the index key for `b`, store `~b` (bitwise inverse) or equivalent for the data type.
- **Schema Def:**
  ```ts
  indexes: {
    my_mixed_index: {
      from: "post",
      sort: [["score", "desc"], ["createdAt", "asc"]]
    }
  }
  ```

## 2. Logical Operators ($or, $and, $not)

### Proposal
Support explicit logical branching.

```ts
db.query({
  from: "post",
  where: {
    $or: [
      { category: "sport" },
      { tags: "sport" }
    ]
  }
})
```

### Implementation
- **$or**: Execute queries separately and union the results. If sorting is required, merge-sort the streams. Unique-ification based on Primary Key is required to prevent duplicates if a record matches both sides.
- **$and**: Implicit in current object syntax, but explicit `$and` is useful for complex nested conditions.
- **$not**: Generally requires a scan unless it converts to a range (e.g. `$ne`).

## 3. Joins, Variables, and Pattern Matching

The most significant proposed change is the "Variable/Pattern Matching" syntax for joins. This resembles Datalog or Graph Pattern Matching (like Cypher).

### Concept
Treat the `from` clause as a set of **Declarations** where we bind fields to **Variables**.

```ts
const fof = db.query({
  from: {
    // 1. Find follows where fromId is $user. Bind the toId to $a.
    relationA: { from: "follow", where: { fromId: "$user", toId: "$a" } },
    
    // 2. Find follows where fromId is $a. Bind the toId to $fof.
    relationB: { from: "follow", where: { fromId: "$a", toId: "$fof" } },
  },
  // 3. Define input variables
  where: {
    $user: "123"
  },
  // 4. Return/Sort
  sort: ["$fof"]
})
```

### Execution Model: "Pipeline" or "Reactive Network"
1.  **Topological Sort:** Analyze dependencies. `$user` is known. `relationA` depends on `$user`. `relationB` depends on `$a` (output of `relationA`).
2.  **Step 1 (Relation A):** Query `follow` index `by_fromId`.
    - Input: `fromId = "123"`
    - Output: Stream of `{ toId }` -> Bind to `$a`.
3.  **Step 2 (Relation B):** For each `$a` from Step 1, query `follow` index `by_fromId`.
    - Input: `fromId = $a`
    - Output: Stream of `{ toId }` -> Bind to `$fof`.
4.  **Result Construction:** The result is a stream of tuples/objects containing the bound variables and potentially the full records `relationA` and `relationB`.

### Advantages
- **N-way Joins:** trivial to express chains.
- **Self-Joins:** naturally handled.
- **Clarity:** "Variables" make the data flow explicit.

### Challenges
- **Loops:** If `a` depends on `b` and `b` depends on `a`. (Disallow for now).
- **Optimization:** "Friends of Friends" can generate massive intermediate sets.
    - *Join Strategy:* Nested Loop is default. Hash Join if we fetch all `$a` first.
    - *Semijoins:* If we only care about `$fof` and not the intermediate `$a`, we can optimize.

## 4. Aggregation and Uniqueness

### Proposal
Support `unique` and grouping on the result variables.

```ts
// Unique friends of friends
db.query({
  from: { ... }, // (as above)
  where: { $user: "1" },
  aggregate: {
    friendId: { value: "$fof", op: "unique" }
  }
})
```

### Issues with "Unique"
- **Streaming Unique:** Requires maintaining a `Set` of seen keys in memory.
- **Memory usage:** For large datasets, this might OOM.
- **Sorted Unique:** If the input is sorted by the field we want unique, it's cheap (just compare with previous). If not, it's expensive.

## 5. Missing Features & Considerations

### Projections (`select`)
The current system returns whole records. We likely need a `select` or `project` clause.
- `select: ["$fof", "relationB.createdAt"]`
- Reduces memory pressure.

### Pagination (Cursors)
`limit` + `offset` is poor for deep pagination.
- We need **Cursor-based pagination**.
- `after: "encoded_cursor_string"`
- The cursor captures the last seen sort keys and primary key.

### Variable Syntax
The `$` prefix is common (Mongo) but conflicts with potential value data.
- **Alternative:** Explicit `var("name")` helper or a specific schema structure.
- However, strings starting with `$` is a very pragmatic heuristic used by many ODMs. We can stick with it and offer an escape mechanism (e.g. `$$literal`) if needed.

## Plan of Action

1.  **Refactor `Query` Type:** Create a discriminated union or recursive type that supports the new `from` object structure.
2.  **Refactor `IndexDefinition`:** Support mixed sort order definition.
3.  **Implement `QueryPlanner`:**
    - A step before `processQuery` that analyzes the query structure.
    - Identify Join order.
    - Select best indexes for each leg.
4.  **Implement `Executor`:**
    - Iterator-based execution (lazy evaluation) to handle streams/pipelines efficiently.
    - `FilterIterator`, `MapIterator`, `JoinIterator` (NestedLoop).
5.  **Add `Comparators`:** Update the scan logic to handle `$gt`, etc. using `TupleDb` range selectors.

