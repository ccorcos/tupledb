## Overview

`tupledb` is a FoundationDB-inspired, transactional, ordered key-value store. It supports both in-memory usage (browser/server) and SQLite persistence (Node.js). The core design philosophy is functional composition over inheritance.

## Architecture

The system is built as a stack of layers implementing the `Okv<K, V>` interface:

1. Storage Layer (Bottom)
  * `InMemoryOkv` (`src/tupleDb/InMemoryOkv.ts`): Uses a sorted array (`OrderedList`) for storage. Fast, supports rich types.
  * `SQLiteOkv` (`src/tupleDb/SQLiteOkv.ts`): Persists to SQLite. Keys/Values are strings.

2. Encoding Layer (Middle)@src/tupleDb/SyncDb.ts @src/tupleDb/sync/

  * Wrappers in `src/tupleDb/Encoder.ts` (`KeyEncodeOKV`, `ValueEncodeOKV`) transform keys/values.
  * Subspaces: Implemented via `TupleSubspaceEncoder`. A subspace is just a prefix-encoded view of the underlying DB.
  * Codec: `src/tupleDb/Codec.ts` handles tuple serialization (`["users", 1] -> "users\x00\x01..."`).

3. Sugar Layer (Top)
  * `TupleDb` (`src/tupleDb/TupleDb.ts`): Adds user-friendly methods (`get`, `set`, `subspace`) on top of `Okv`.
  * `Transaction` (`src/tupleDb/Transaction.ts`): Buffers writes in an `InMemoryOkv` overlay. Reads merge committed data with pending writes.

## Key Conventions

### 1. The `Okv` Interface
Everything revolves around this interface defined in `src/tupleDb/types.ts`:

```ts
type Okv<K, V> = {
    compare: (a: K, b: K) => number
    list(args?: ListArgs<K>): { key: K; value: V }[]
    write(tx: WriteArgs<K, V>): void
}
```
* Always respect the `compare` function. Do not assume standard JS comparison.
* Immutability: `list` should return copies or treated as read-only.

### 2. Functional Composition
New features should generally be implemented as wrappers around `Okv` rather than modifying core classes.
* Pattern: `function MyFeatureOkv(db: Okv): Okv { ... }`

### 3. Testing
- we're using `node:test` and `node:assert` packages fopr testing.
- to run a single file `npx tsx path/to/file.test.ts`
- IMPORTANT: to run tests, use `npm test`.
- test files are co-located as `*.test.ts` files.
- always check types to verify no type errors `npm run typecheck`.

### 4. Code Style
* Formatting: Prettier (`npm run prettier`).
* Imports: Use explicit relative paths.
* Types: Strict TypeScript

## Directory Structure
* `src/tupleDb/`: Core database logic.
* `src/shared/`: Low-level utilities (comparison, data structures).
