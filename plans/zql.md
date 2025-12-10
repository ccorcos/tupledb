# Analysis of RecordLayer.ts vs zql/ivm

## Goal
Improve `src/tupledb/RecordLayer.ts` by adopting Incremental View Maintenance (IVM) patterns from `mono/packages/zql/src/ivm`, specifically focusing on indexes, aggregations, and joins.

## Current State (`RecordLayer.ts`)
- **Architecture**: Imperative, hardcoded updates. `setRecord` and `deleteRecord` manually call `updateIndexes`, `triggerUpdates` (which calls `updateAggregation`, `updateJoin`).
- **Indexes**: 
  - Defined in `RecordSchema.indexes`.
  - Materialized as `[type, indexName, ...values, ...primaryKey]`.
  - Requires manual selection via `db.index(type, name, args)`.
- **Aggregations**:
  - Only supports `count`.
  - Materialized as `["aggregation", name, ...groupByValues]`.
- **Joins**:
  - Materialized as `["join", name, ...keys]`.
  - Updates require lookups (`findMatches`) to find related records and update the join table.
  - "Algebraic" approach (materializing the cross-product of relationships).

## Insights from `zql/ivm`
- **Architecture**: Reactive, Pipeline-based.
  - **Sources** (`Source`, `MemorySource`) emit `Change` events (`add`, `remove`, `edit`).
  - **Operators** (`Filter`, `Join`, `View`) process these streams.
  - **Views** maintain the final state.
- **Indexes**:
  - `MemorySource` maintains B-Tree indexes dynamically (`#indexes` map).
  - Indexes are created/selected based on `sort` order and `filters` (constraints).
  - This allows for "query-driven" index usage rather than "name-driven".
- **Joins**:
  - Implemented as an Operator (`Join`).
  - It listens to changes from `parent` and `child` sources.
  - It maintains a hierarchical view (`Node` with `relationships`).
  - It uses `fetch` with `constraint` on the child source, implying efficient lookups (index usage) are delegated to the source.
- **Change Propagation**:
  - The `Change` type (`add`, `remove`, `edit`, `child`) carries the delta, allowing downstream operators to update incrementally without full re-computation.

## Proposed Improvements for `RecordLayer`

### 1. Unified IVM Engine (The "Reactor" Pattern)
Instead of hardcoding `updateIndexes`, `updateJoin`, etc., inside `setRecord`, we should implement a general-purpose **Change Listener** system.
- Define a `Change` interface (similar to `zql`): `{ type: 'set' | 'del', record: any, oldRecord?: any }`.
- `RecordDb` maintains a list of **View Maintainers** (or "Reactors").
- Indexes, Aggregations, and Joins become just different types of Reactors.
- **Benefit**: Extensibility. New types of views (e.g., specific "Feed" views) can be added without modifying the core `setRecord` logic.

### 2. Intelligent Indexing & Querying
- **Current**: `db.index("user", "byName", { eq: { name: "Alice" } })`
- **Proposed**: `db.scan("user", { where: { name: "Alice" } })`
  - The layer analyzes the `where` clause.
  - Checks `schema.records[type].indexes` to find a matching index (prefix match).
  - Automatically uses the best index.
- **Derived Indexes**: Allow indexes on computed properties (functions of the record), not just direct field names.

### 3. Enhanced Aggregations (Reducers)
- **Current**: Hardcoded `increment`.
- **Proposed**: Generic **Reducer** interface.
  - `type Reducer<T> = { add: (acc: T, record: any) => T, remove: (acc: T, record: any) => T }`
  - Support `Sum`, `Min`, `Max`, `Average` (stores count + sum).
  - Store aggregation state in a more generic way.

### 4. Optimized & Virtual Joins
- **Current**: Materialized Join (writes `(A, B)` pairs). Good for read heavy, bad for write heavy.
- **Proposed**:
  - **Virtual Joins (Read-time)**: For simple foreign key relationships, don't materialize. Just provide a helper `db.joinQuery("comments", { matching: { userId: user.id } })` which uses the "byUserId" index on comments.
  - **Fan-out Writes (Feed style)**: As per `TODO.md`, for "Feeds", we might want to "fan out" writes. When a user creates a post, write a "FeedItem" record for every follower. This is a specific kind of Materialized View.
  - **Recursive Indexes**: For "Followers of Followers", we can implement a specific Reactor that maintains a graph edge list or a transitive closure (carefully).

### 5. Schema Definition Evolution
Move towards a more descriptive schema that defines *relationships* and *views*, rather than just storage artifacts.

```typescript
type Schema = {
  models: {
    user: { ... },
    post: { ... },
    follow: { ... }
  },
  views: {
    "postsByAuthor": { type: "index", on: "post", fields: ["authorId", "createdAt"] },
    "userPostCount": { type: "aggregate", on: "post", groupBy: ["authorId"], op: "count" },
    "userFeed": { 
      type: "fanout", 
      source: "post", 
      target: "feedItem",
      via: "follow", // join logic
      // ...
    }
  }
}
```

## Next Steps
1.  Refactor `RecordLayer.ts` to extract `update*` logic into a `ViewSystem` class.
2.  Implement `Change` propagation.
3.  Implement a `QueryPlanner` helper for selecting indexes.
