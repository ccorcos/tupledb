# Refactor Plan: Unifying Indexes and Queries in RecordLayer

## 1. Goal
The primary objective is to unify the concepts of **Record Indexes**, **Aggregations**, and **Joins** into a single, cohesive concept: **Materialized Queries**. 
In this model, an index is simply a stored definition of a query whose results are automatically maintained (materialized) by the database.

## 2. Conceptual Architecture

### 2.1. The Unification
Currently, the schema has three distinct buckets: `records` (indexes), `aggregations`, and `joins`. 
We will replace these with a unified `indexes` map, where every entry is a `QueryDefinition`.

| Feature | Current Schema Definition | New Unified Definition (Conceptual) |
| :--- | :--- | :--- |
| **Standard Index** | `records: { [type]: { [name]: [fields] } }` | `indexes: { [name]: { from: type, sort: [fields] } }` |
| **Aggregation** | `aggregations: { [name]: { source, groupBy, kind } }` | `indexes: { [name]: { from: source, groupBy: [...], aggregate: { val: kind } } }` |
| **Join** | `joins: { [name]: { left, right, key } }` | `indexes: { [name]: { from: { left, right, key }, ... } }` |

### 2.2. New Schema Structure
The `RecordDbSchema` will be reorganized. We still need to define the "Types" (Tables) and their primary keys, as this is the source of truth for the raw records.

```typescript
type Schema = {
    // Defines the canonical storage for each record type.
    types: {
        [typeName: string]: { primary: string[] }
    },
    // Defines all materialized views (indexes, joins, aggs).
    // The key is the 'Index Name'.
    indexes: {
        [indexName: string]: IndexDefinition
    }
}
```

`IndexDefinition` will be a stricter subset of `QueryQuery`:
-   **Allowed:** `from`, `where` (future), `sort`, `groupBy`, `aggregate`.
-   **Disallowed:** `limit`, `reverse` (these are runtime view properties).

### 2.3. Storage Layer Changes
To support scalable schema management (and "indexing the indexes" in the future), we will move from a single JSON blob (`_schema/current`) to a subspace structure:

-   `_schema/types/[typeName]` -> `{ primary: [...] }`
-   `_schema/indexes/[indexName]` -> `IndexDefinition`

This allows us to add/remove indexes transactionally without reading/writing the entire schema history.

## 3. Implementation Plan

### Phase 1: Foundations & Types
1.  **Define `IndexQuery`**: Create the type definition for a stored query (the Index).
2.  **Schema Manager**: Implement functions to load/save schema from the new subspace structure.
    -   `loadSchema(db)`: Scans `_schema/*` to build the in-memory schema object.
    -   `addIndex(db, name, def)`: Writes a single index definition.
    -   `removeIndex(db, name)`: Removes an index definition.

### Phase 2: The Unified Write Path (The "Materializer")
Refactor `updateIndexes` to be a generic view maintenance system.

-   **Logic**:
    1.  Iterate over all definitions in `schema.indexes`.
    2.  Check `affects(indexDef, change)`:
        -   If `index.from` matches `change.type`.
        -   (For Joins) If `index.from` involves `change.type` (left/right).
    3.  **Dispatch Update**:
        -   **Aggregation**: If `index.aggregate` is present -> Call `updateAggregationView`.
        -   **Join**: If `index.from` is complex -> Call `updateJoinView`.
        -   **Standard**: Else -> Call `updateStandardView` (handles `sort` and `where`).

This removes the hardcoded "check records, then aggs, then joins" sequence and replaces it with a data-driven approach.

### Phase 3: The Unified Read Path (The "Planner")
Refactor `processQuery` to match runtime queries against stored indexes.

-   **Logic**:
    1.  **Exact Match**: Does an index exist with the exact same `from`, `where`, `sort`, `groupBy`? Use it.
    2.  **Covering Match**: Does an index exist that *contains* the data needed?
        -   Example: Query `sort: [a]`, Index `sort: [a, b]`. -> Usable.
        -   Example: Query `where: {a: 1}`, Index `sort: [a, b]`. -> Usable (Prefix scan).
    3.  **Auto-Indexing**:
        -   If no match found, create a new `IndexDefinition` derived from the query.
        -   Trigger `backfillIndex`.
        -   Save new index to schema.
        -   Execute query against new index.

## 4. Analysis

### Benefits
-   **Simplicity**: Reduces 3 concepts to 1. Less code duplication in the long run.
-   **Power**: "Conditional Indexes" (indexes with `where` clauses) become architecturally native.
    -   *Note*: We will restrict `where` initially to avoid complexity, but the door is open.
-   **Flexibility**: Adding a new index type (e.g., Full Text) fits into the `IndexDefinition` system without changing the core loop.

### Costs & Trade-offs
-   **Ambiguity**: Matching a runtime query to a stored index is harder than looking up a name.
    -   *Mitigation*: We will implement strict matching first (structural equality) before fuzzy "best fit" matching.
-   **Performance**: Iterating all index definitions on every write/read could be slow if there are thousands.
    -   *Mitigation*: In-memory lookup maps (e.g., `indexesBySourceType`) will be maintained by the Schema Manager.
-   **Migration**: The underlying storage format of the schema changes. Existing databases will need a migration or reset.

## 5. Specific Considerations
-   **Ambiguities**: User noted queries can be ambiguous. By storing the *definition* as a query, we ensure that the index *is* exactly what it says it is. The complexity lies only in selecting the right index for a `db.query(...)` call.
-   **Conditional Indexes**: We will enforce `where: undefined` in `IndexDefinition` for the initial implementation to keep the "Write Path" simple (avoiding complex filter logic evaluation during updates).
