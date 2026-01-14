# Code Patterns and Style

## Core Philosophy

1. **Functional Composition Over Inheritance** - New features wrap `Okv` rather than extend classes
2. **Classes for State Only** - Use functions for composition, classes only when encapsulating mutable state
3. **Explicit Over Implicit** - Clear data flow, no magic
4. **Small Functions** - Prefer inline code over tiny abstractions

## When to Use Classes vs Functions

### Use Classes When:

Encapsulating mutable state that needs to be managed:

```typescript
// Good: InMemoryOkv manages internal array state
class InMemoryOkv<K, V> implements Okv<K, V> {
  private data: OrderedList<{ key: K; value: V }>

  constructor(compare: (a: K, b: K) => number) {
    this.data = new OrderedList(...)
  }

  list(args) { ... }
  write(args) { ... }
}

// Good: Transaction manages pending writes
class Transaction<K, V> implements OkvTx<K, V> {
  committed = false
  pending: { set: InMemoryOkv; delete: InMemoryOkv }
  ...
}
```

### Use Functions When:

Composing or transforming existing objects:

```typescript
// Good: syncServer composes db, reducers, and options
function syncServer(
  db: TupleDb,
  reducers: ReducerMap,
  options: { publish?: (scope, clock) => void }
): SyncApi {
  return {
    write: (scope, commits) => { ... },
    fetch: (scope, sinceClock) => { ... },
  }
}

// Good: tupleDb adds sugar to underlying Okv
function tupleDb(db?: TupleOkv): TupleDb {
  if (!db) db = tupleOkv()
  return {
    ...db,
    get: (key) => db.list({ gte: key, lte: key }).at(0)?.value,
    set: (key, value) => db.write({ set: [{ key, value }] }),
    ...
  }
}
```

## Loop Preferences

Prefer loops when they avoid variable mutation and improve readability:

```typescript
// Prefer this:
for (const [name, fields] of Object.entries(schema.records[type])) {
  if (name === "primary") continue
  const match = matchIndex(fields, whereKeys, sortKeys)
  if (match) return match
}

// Over this:
const existing = Object.entries(schema.records[type]).find(([name, fields]) => {
  if (name === "primary") return false
  return matchIndex(fields, whereKeys, sortKeys)
})
if (existing) return { schema, indexName: existing[0] }
```

Use array methods when the transformation is clean:

```typescript
// Fine: clear transformation
const keys = items.map(({ key }) => key)

// Fine: simple filter
const nonNull = items.filter(v => v !== null)
```

## Avoiding Unnecessary Recursion

When code paths are distinct, use direct calls instead of recursing with different branches:

```typescript
// Bad: Unnecessary recursion
function createIndex(query) {
  if (isJoinQuery(query)) {
    ensureRecordIndex(extractRecordQuery(query))  // calls createIndex internally
    backfillIndex(query)
  } else {
    backfillRecordIndex(query)
  }
}

// Good: Direct calls, no recursion
function createIndex(query) {
  if (isJoinQuery(query)) {
    createJoinIndex(query)
  } else {
    createRecordIndex(query)
  }
}

function createJoinIndex(query) {
  ensureRecordIndex(query.source)  // createRecordIndex if needed
  backfillJoinIndex(query)
  saveJoinIndex(query)
}

function createRecordIndex(query) {
  backfillRecordIndex(query)
  saveRecordIndex(query)
}
```

## Naming Conventions

### Functions

Use verb prefixes that describe the action:

```typescript
// CRUD-style
createType, createIndex, deleteIndex
get, set, delete, has

// Query/transform
findIndex, matchIndex, extractKey
encodeRange, decodeRange

// Lifecycle
backfillIndex, updateIndexes, propagateChange
```

### Consistent naming across similar operations:

```typescript
// Good: Consistent pattern
backfillRecordIndex(query)
backfillAggregationIndex(query)
backfillJoinIndex(query)

// Bad: Inconsistent
backfillRecords(query)
fillAggregation(query)
populateJoinData(query)
```

### Types

- Interfaces/types: PascalCase (`TupleDb`, `WriteArgs`, `ListOptions`)
- Type parameters: Single uppercase letter or descriptive (`K`, `V`, `R extends ReducerMap`)

## Avoiding Small Wrapper Functions

Don't create tiny functions just for the sake of abstraction:

```typescript
// Bad: Too small, just inline it
function scanAllRecords(db, type) {
  return db.subspace([type, "primary"]).list()
}

// Good: Just use directly
const records = db.subspace([type, "primary"]).list()
```

Exception: When the abstraction provides meaningful naming or is used in 3+ places.

## Error Handling

Throw descriptive errors early:

```typescript
// Good
function write(args) {
  if (this.committed) throw new Error("Transaction already committed")
  ...
}

// Good: Validation blocks with labeled breaks
VALIDATION: {
  if (authorId === adminId) break VALIDATION
  if (authorId !== obj.id) throw new ValidationError("You can only edit yourself")
}
```

## Type Safety

Use strict TypeScript, avoid `any` when possible:

```typescript
// Bad
const dataWrapper: any = { ... }

// Good
const dataWrapper: ReadOnlyTupleDb = readOnlyTupleDb(...)
```

Use `satisfies` for type checking without widening:

```typescript
const reducers = {
  set: (tx: TupleDb, key: Tuple, value: any) => tx.set(key, value),
  delete: (tx: TupleDb, key: Tuple) => tx.delete(key),
} satisfies ReducerMap
```

## Import Style

Use explicit relative paths:

```typescript
// Good
import { tupleDb } from "./TupleDb"
import { codec } from "../tupleDb/Codec"

// Avoid barrel exports unless necessary
```

## Testing

Co-locate tests with source:

```
src/tupleDb/
├── TupleDb.ts
├── TupleDb.test.ts
├── OkvCache.ts
├── OkvCache.test.ts
```

Use `node:test` and `node:assert`:

```typescript
import { describe, it } from "node:test"
import assert from "node:assert"

describe("TupleDb", () => {
  it("sets and gets values", () => {
    const db = tupleDb()
    db.set(["a"], 1)
    assert.strictEqual(db.get(["a"]), 1)
  })
})
```

## Formatting

Run Prettier before committing:

```bash
npm run prettier
```

## Documentation

- Avoid excessive comments - code should be self-documenting
- Document non-obvious algorithms or tricky edge cases
- Use JSDoc sparingly, only for public APIs

```typescript
// Good: Documents non-obvious behavior
/**
 * This version will overfetch as needed to satisfy the limit in a single request.
 * An alternative approach would not overfetch but will need to make multiple requests.
 */
list = (args: ListArgs<K> = {}): { key: K; value: V }[] => {
  ...
}

// Bad: Obvious comment
// Sets the value
set(key, value) { ... }
```
