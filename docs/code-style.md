# Coding Style & Architecture Guide

This document defines the preferred coding style and architectural patterns for this project. Use these guidelines when refactoring or adding new features.

## 1. Control Flow & Loops

**Prefer `for` loops over array methods (like `find`, `reduce`) when complex logic or early returns are involved.**

Array methods can be elegant for simple transformations, but `for` loops are often more readable and performant when you need to break early or handle complex conditions without creating closure scopes.

**Bad:**
```ts
// Hard to read early return logic
const existing = Object.entries(schema.records[type]).find(([name, fields]) => {
    if (name === "primary") return false
    return matchIndex(fields, whereKeys, sortKeys)
})
if (existing) return { schema, indexName: existing[0] }
```

**Good:**
```ts
for (const [name, fields] of Object.entries(schema.records[type])) {
    if (name === "primary") continue
    const match = matchIndex(fields, whereKeys, sortKeys)
    if (match) return match
}
```

## 2. Specialization Over Generalization (The "Dispatcher" Pattern)

**Avoid monolithic functions that handle multiple distinct cases via internal branching or recursion.**

Instead of having one function that recursively calls itself with different arguments to handle different logic branches, split the logic into specialized functions and use a "dispatcher" function to route the call.

**Goal:** Flatten the call stack and make the logic for each specific case linear and self-contained.

**Bad (Mixed Logic & Recursion):**
```ts
function createIndex(q: Query) {
    if (isJoin(q)) {
        // ... complex join logic ...
        // Recursive call handling a different type (RecordQuery)
        createIndex(recordQuery)
        // ... more logic ...
    } else {
        // ... record index logic ...
    }
}
```

**Good (Dispatcher & Specialized Functions):**
```ts
// Dispatcher
export function createIndex(db: TupleDb, schema: Schema, q: Query) {
    if (isJoinQuery(q)) return createJoinIndex(db, schema, q)
    if (isAggregationQuery(q)) return createAggregationIndex(db, schema, q)
    return createRecordIndex(db, schema, q)
}

// Specialized Implementation
function createJoinIndex(db: TupleDb, schema: Schema, q: JoinQuery) {
    // ... linear join logic ...
    // Explicit call to other specialized function if needed
    createRecordIndex(db, schema, leftRecordQuery)
}

function createRecordIndex(db: TupleDb, schema: Schema, q: RecordQuery) {
    // ... linear record logic ...
}
```

**Naming Convention:**
Use consistent naming for these specialized groups (e.g., `createX`, `backfillX`, `updateX`, `saveX`).

## 3. Composition & Minimal Surface Area

**Prefer Functional Composition over Inheritance.**

Build abstractions by wrapping objects. Separate the "Base API" (core primitives) from the "Sugar API" (convenience methods).

**Design Principle:**
Keep the "Base API" interface as small as possible. This makes it easier to create wrappers (like encoders, middleware, or subspaces) because they only need to implement a few methods. Implement convenience methods ("Sugar") as a separate layer that sits on top of the Base API.

**Example (`TupleDb`):**
```ts
// Base Layer: Minimal API (Just list and write)
export function tupleOkv(okv?: Okv): TupleOkv { ... }

// Wrappers only need to handle the minimal API
export function subspace(db: TupleOkv, prefix: Tuple): TupleOkv {
    return {
        list: (args) => ... , // Transform args and result
        write: (args) => ... , // Transform writes
        compare: db.compare
    }
}

// Sugar Layer: Adds get/set/delete wrappers around the base list/write
export function tupleDb(db?: TupleOkv): TupleDb {
    const { list, write } = db
    return {
        list,
        write,
        // Convenience methods derived from primitives
        get: (key) => list({gte: key, lte: key})[0]?.value,
        set: (key, val) => write({set: [{key, value: val}]}),
    }
}
```

## 4. Canonical Data Representation

**Normalize complex inputs early.**

If logic depends on comparing complex objects (like ranges, queries, or index definitions), convert them into a canonical (unambiguous/normalized) form as early as possible. This simplifies downstream logic by removing the need to handle variations.

**Example:**
- `toUnambiguousIndex(q)` converts a flexible query object into a strict definition (sorting keys, merging fields).
- `encodeRange(r)` converts various range formats (gt, gte, open, closed) into a standard tuple format for comparison.

## 5. Interfaces & Types

**Use Composition in Types.**
Prefer intersection types (`&`) or explicit property inclusion over deep interface inheritance hierarchies when defining component capabilities.

```ts
export type TupleTx = TupleOkvTx & {
    get: (key: Tuple) => JSONValue | undefined
    set: (key: Tuple, value: JSONValue) => void
    // ...
}
```
