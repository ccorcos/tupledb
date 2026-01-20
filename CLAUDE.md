# TupleDB

A FoundationDB-inspired, transactional, ordered key-value store with incremental view maintenance and sync capabilities. Designed to work both server-side (with SQLite) and client-side (in-memory in browsers) using identical abstractions.

## Quick Reference

```bash
npm test          # Run all tests
npm run typecheck # Check types
npm run prettier  # Format code
npx tsx path/to/file.test.ts  # Run single test file
```

## Project Structure

```
src/
├── tupleDb/     # Core ordered key-value store and cache
├── recordDb/    # Schema layer with incremental view maintenance (IVM)
├── syncDb/      # Replication and history tracking
└── shared/      # Utilities (comparison, ordered lists, etc.)

docs/
├── architecture.md   # Layered design and key abstractions
├── getting-started.md # Usage examples and quick start
├── patterns.md       # Code style and conventions
└── roadmap.md        # Future direction and planned features
```

## Architecture Overview

The system is built as composable layers implementing the `Okv<K, V>` interface:

```
Storage (InMemoryOkv, SQLiteOkv)
    ↓
Encoding (Codec, KeyEncoder, ValueEncoder)
    ↓
TupleDb (sugar API: get, set, delete, subspace)
    ↓
┌───────────────┬────────────────────────────────┐
│   RecordDb    │            SyncDb              │
│  (IVM/Schema) │  syncDb → appDb → syncServer   │
└───────────────┴────────────────────────────────┘
```

## Core Types

```typescript
// The foundation - everything builds on this
type Okv<K, V> = {
  compare: (a: K, b: K) => number
  list(args?: ListArgs<K>): { key: K; value: V }[]
  write: (tx: WriteArgs<K, V>) => void
}

// User-friendly tuple database
type TupleDb = TupleOkv & {
  get: (key: Tuple) => JSONValue | undefined
  set: (key: Tuple, value: JSONValue) => void
  delete: (key: Tuple) => void
  subspace: (prefix: Tuple) => TupleDb
}

// SyncDb for history tracking and replication
type SyncDb = {
  clock(): number
  history(range?: ListArgs<Tuple>): { key: Tuple; value: Commit }[]
  data: TupleDb
  apply(commit: CommitMeta & { ops: Op[] }): void
}

// Reducers handle operations with type-safe args
type Reducer = (tx: TupleDb, commit: CommitMeta, ...args: any[]) => void
type ReducerMap = Record<string, Reducer>
```

## Key Principles

1. **Functional Composition** - New features wrap `Okv` rather than inherit
2. **Respect the Compare Function** - Never assume standard JS comparison
3. **Immutability** - `list` returns copies, treat as read-only
4. **Classes for State Only** - Use functions for composition, classes only when encapsulating state

## Documentation

- **[Architecture](docs/architecture.md)** - Deep dive into the layered design
- **[Getting Started](docs/getting-started.md)** - Examples and usage patterns
- **[Code Patterns](docs/patterns.md)** - Style guide and conventions
- **[Roadmap](docs/roadmap.md)** - Future direction and planned features

## Current Status

| Layer | Status | Description |
|-------|--------|-------------|
| TupleDb | ✓ Complete | Core OKV, transactions, subspaces, cache |
| RecordDb | ✓ Complete | Schema, auto-indexing, joins, aggregations, IVM |
| SyncDb Server | ✓ Complete | History tracking, replication API |
| SyncDb Client | ⚠️ Partial | Types defined, client implementation WIP |

## Development Notes

- Test files are co-located as `*.test.ts`
- Use `node:test` and `node:assert` for testing
- Do not use `git` commands unless explicitly directed
- Ignore anything in TODO.md
- Few / minimal comments
