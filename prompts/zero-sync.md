# ZeroDb Synchronization Mechanism

ZeroDb uses a WebSocket-based push model to synchronize state between the client (browser) and the server. While it leverages Replicache for local state management and speculative mutations, it replaces Replicache's default HTTP-based pull mechanism with a custom WebSocket protocol.

## 1. Registration (Subscriptions)

The browser registers subscriptions (queries) with the server to indicate which data it is interested in.

*   **Query Tracking**: The `QueryManager` class (`packages/zero-client/src/client/query-manager.ts`) tracks all active queries. Queries are added via `zero.addCustom()` or `zero.addLegacy()`, which correspond to `zero.query` usages in the application.
*   **Protocol**:
    *   **Initial Connection**: When the client connects, it sends the current set of desired queries to the server. This is often optimized by encoding them into the `Sec-WebSocket-Protocol` header during the WebSocket handshake to minimize round-trips.
    *   **Dynamic Updates**: As queries are added or removed (e.g., components mounting/unmounting), `QueryManager` sends `changeDesiredQueries` messages over the WebSocket. These messages contain a "patch" (`put`/`del` operations) of the desired queries.
*   **Throttling**: `QueryManager` throttles these updates (default 10ms) to batch multiple changes into a single message.

## 2. Receiving Updates

The server pushes updates to the client via "poke" messages.

*   **Poke Protocol**: Updates are sent as a multi-part sequence: `pokeStart`, `pokePart` (one or more), and `pokeEnd`.
*   **Content**: `pokePart` messages contain patches:
    *   `rowsPatch`: Actual data changes (`put`, `del`, `update` operations) on tables.
    *   `gotQueriesPatch`: Acknowledgments indicating which queries are now fully synced.
    *   `lastMutationIDChanges`: Updates to the last processed mutation ID for clients, confirming that optimistic mutations have been processed by the server.
*   **PokeHandler**: The `PokeHandler` class (`packages/zero-client/src/client/zero-poke-handler.ts`) manages incoming pokes.
    *   **Buffering & Merging**: It buffers incoming poke parts and merges them into a single update.
    *   **Frame-Rate Limiting**: To avoid blocking the main thread and causing UI stutter, it applies the merged update to the local Replicache database at most once per animation frame (`requestAnimationFrame`).

## 3. Catch Up (Offline -> Online)

When the client comes back online, it "catches up" by re-establishing the WebSocket connection and negotiating the state difference.

*   **Cookie-Based Resume**: The client maintains a `cookie` (from Replicache) representing its last synced state.
*   **Handshake**: When connecting:
    1.  The client sends its `baseCookie` (the last cookie it has) and its current `desiredQueries` to the server.
    2.  The server uses the `baseCookie` to compute the "diff" of changes that occurred while the client was offline.
    3.  The server pushes this diff as a sequence of `poke` messages immediately after the connection is established.
*   **No Explicit Pull**: Unlike standard Replicache which polls an HTTP endpoint, ZeroDb's `puller` implementation is largely a no-op for the main client group. It relies entirely on the server to push the required state upon connection.
*   **Mutation Recovery**: There is a special case for "mutation recovery" where a specific `pull` might be triggered, but the primary sync flow is push-based.

## 4. Versioning & Efficiency

ZeroDb achieves efficient sync through a server-side data structure called the **Client View Record (CVR)**.

### The CVR (Client View Record)
The CVR is essentially a "materialized view" of exactly what a specific Client Group (e.g., a user's session or browser tab group) currently knows. It is stored in the `cvr` schema in the server's Postgres database (e.g., `{app_id}_0/cvr`).

*   **The "Cookie"**: The `cookie` held by the client is a pointer to a specific version of the CVR (e.g., `5nbqa2w:09`).
*   **State Tracking**: The CVR tracks:
    *   **Queries**: Which queries the client is subscribed to (`cvr.queries`).
    *   **Rows**: A reference to every row the client currently has (`cvr.rows`), including its version.
    *   **Ref Counts**: Since multiple queries might overlap and match the same row, the CVR maintains a reference count (`refCounts`) for each row.

### Incremental Updates
When the client is **Online**, the server does *not* re-run queries or diff the entire dataset for every change. Instead, it uses **Incremental View Maintenance (IVM)** pipelines.
1.  **Upstream Change**: A write happens in the main database.
2.  **IVM Pipeline**: The server's pipeline processes the change and determines exactly which subscribed queries are affected (`add`, `edit`, `remove`).
3.  **CVR Update**:
    *   **Put**: If a row is added or updated, the server updates the row in `cvr.rows` and bumps its `patchVersion` to the current CVR version.
    *   **Del**: If a row is removed (or `refCount` drops to 0), it is **not** immediately deleted from `cvr.rows`. Instead, it is updated with `refCounts: NULL` and a new `patchVersion`. This acts as a "tombstone".
4.  **Push**: The server pushes these specific row changes to the client.

### Catch-Up Efficiency
When a client Reconnects (e.g., coming back online):
1.  The client sends its last `cookie` (CVR Version).
2.  The server queries `cvr.rows` for all rows where `patchVersion > clientCookie`.
3.  **Efficiency**: This is a simple range query on an index. It returns exactly the rows that changed (updates and tombstones) since the client was last online.
4.  **No Re-computation**: The server does *not* need to re-run the user's complex queries to calculate the diff. The history of changes is preserved in the CVR's `patchVersion`.

### Trade-offs
*   **Efficiency (Compute)**: Extremely high. Catch-up is a cheap index scan. Real-time updates use efficient IVM.
*   **Cost (Storage)**: Higher. The server maintains a "copy" (or at least references) of the client's data in the CVR tables. Tombstones (`refCounts: NULL`) accumulate to ensure disconnected clients can catch up, though they are scoped to the specific Client Group.
*   **Write Amplification**: Writes to the main database trigger writes to the CVR database to maintain these views.
