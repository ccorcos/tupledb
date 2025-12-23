Design Doc: Durable Differential Dataflow on TupleDB
1. Core Data Model: The Diff
We strictly adhere to Differential Dataflow semantics. We do not process "Events"; we process Updates.

TypeScript
type Diff = number // +1, -1, +2, etc.

type Update<T> = {
    key: Tuple  // The Identity
    val: T      // The Data
    diff: Diff  // The Change
}

// In the database, a Multiset is stored as:
// Key: [...Tuple, Value] -> Value: Count (Diff Sum)
Invariant: If Count reaches 0, the key is deleted from tupledb.

2. Architecture: Everything is an Index
There are no "hidden" subspaces. Every step of the pipeline produces a named, queryable Index (a persistent Multiset).
Source: A read-only Index wrapping a raw table.
Map/Filter: A derived Index.
Join: A derived Index produced by combining two other Indexes.
Aggregation: A derived Index produced by reducing another Index.
3. The API (Explicit & Reusable)
3.1 The Primitives
source(name) Defines an input stream.

TypeScript
const Users = source("users")
index(name, parent, keyFn) Projects data into a new sort order (Multiset). This is the primary unit of storage.

TypeScript
// Creates top-level table "posts_by_author"
// Useful for Joins AND Range Scans
const PostsByAuthor = index(
    "posts_by_author",
    Posts,
    p => [p.authorId, p.id]
)
join(name, leftIndex, rightIndex, logic) Joins two existing Indexes. You cannot join raw sources; you must index them on the join keys first. This ensures the costs are explicit and the indexes are reusable.

TypeScript
const Feed = join(
    "feed",
    FollowsByToId,   // Reusing an existing index
    PostsByAuthor,   // Reusing an existing index
    (follow, post) => ({ ... })
)
derive(name, index, aggregator) Computes a value from a specific Index group.

TypeScript
const PostCounts = derive(
    "post_counts",
    PostsByAuthor, // Groups by the prefix (AuthorId)
    Aggregators.Count()
)
4. Implementation Details (The Math)
4.1 Differential Join
Since we join two Indexes, we don't need to build internal hash maps. The Indexes are the maps.

To join LeftIndex (L) and RightIndex (R):
Input: Update on L -> (Key: K, Val: V_L, Diff: D_L)
Lookup: Scan R for K. Found (Val: V_R, Count: C_R)
Output: Emit (Val: V_Result, Diff: D_L * C_R)
Note: The Diff multiplies. If we add 1 Follower and that person has 5 Posts, we add 5 items to the Feed.

4.2 Differential Aggregation (Count/Sum)
We don't need to read the DB. We just forward the diff.
Input: Update on I -> (Key: K, Val: V, Diff: D)
Logic: NewTotal = OldTotal + D
Output: Diff is the change in the total.
4.3 Differential Max (The Hybrid)
Max is not a linear algebra operation, so we rely on the TupleDb sort order.
Input: Update (Key, Val, Diff)
Action: Update the backing Multiset (apply Diff to Count).
Check: Did the change affect the last item in the index?
Query: If yes, db.list({ reverse: true, limit: 1 }).
5. Usage Example: The "Explicit" Social Graph
Notice how every intermediate index is named and potentially queryable by the application for other features (like "Show me all friends of X").

TypeScript
// 1. Sources
const Follows = source("follows")
const Posts = source("posts")

// 2. Base Indexes (Reusable)
// These are explicit top-level tables.
const FollowsByTo = index(
    "idx_follows_to",
    Follows,
    f => [f.toId, f.fromId]
)

const FollowsByFrom = index(
    "idx_follows_from",
    Follows,
    f => [f.fromId, f.toId]
)

const PostsByAuthor = index(
    "idx_posts_author",
    Posts,
    p => [p.authorId, p.id]
)

// 3. Social Graph Join
// "Who follows whom" joined with "Who follows whom"
// Uses the explicit indexes defined above.
const FriendsOfFriends = join(
    "graph_2nd_degree",
    FollowsByTo,    // Left: f1.toId (The link)
    FollowsByFrom,  // Right: f2.fromId (The link)
    (f1, f2) => ({
        me: f1.fromId,
        stranger: f2.toId
    })
)

// 4. Index the Graph
// We need to index the result of the join to use it in the next step.
// We index by 'stranger' because we want to join with their posts.
const FoFByStranger = index(
    "idx_fof_stranger",
    FriendsOfFriends,
    g => [g.stranger, g.me]
)

// 5. The Feed Join
const ExploreFeedRaw = join(
    "explore_feed_raw",
    FoFByStranger,
    PostsByAuthor, // Reuse!
    (graph, post) => ({
        user: graph.me,
        post
    })
)

// 6. Final User View
// Sort by Time for the UI
const ExploreFeed = index(
    "view_explore_feed",
    ExploreFeedRaw,
    item => [item.user, item.post.createdAt]
)
6. Developer Experience Summary
Debugging:
Why is the feed empty?
Check db.scan("idx_follows_to").
Check db.scan("graph_2nd_degree").
You can trace the data flow through named tables.
Flexibility:
The PostsByAuthor index is created once for the Feed.
But you can also use it to display the user's profile page: db.list("idx_posts_author", { prefix: [userId] }).
You get "backend" features for free just by defining your pipeline.
Performance:
Because join requires pre-existing index inputs, it is impossible to write an accidental full-table-scan join. The API forces you to create the necessary structures for performance.



Differential Dataflow: You specifically requested the semantics of Differential Dataflow (using integer diffs +/- 1 to represent updates) rather than simple add/delete events.
Durability: All intermediate states (joins, aggregations) must be persisted in TupleDb to survive restarts (Durable Datalog).
2. Developer Experience (DX) & API Style
Functional & Compositional: The API must use pure functions composed together (from, map, join, etc.) rather than class instantiation (new).
POJOs over Classes: Functions should return simple configuration objects (definitions), not active class instances.
Uniformity ("Everything is a Table"): There should be no distinction between a "Source," an "Index," or a "View." Every step of the pipeline produces a queryable table.
3. Visibility & Naming
Explicit Naming: You rejected hidden internal subspaces (e.g., _ivm). Every index must have an explicit, top-level name provided by the developer.
Reusable Intermediate States: Intermediate indexes (especially for Joins) must be explicitly defined and named so they can be reused by other parts of the application or queried directly for debugging.
4. Implementation Details
Separation of Index vs. Derive: You critiqued the conflation of storage and logic in reduce. We split this into:
index(): The expensive storage operation (creating the subspace).
derive(): The logic operation (computing the value).
Aggregation Logic:
Generalized: Logic should not be hardcoded strings (e.g., "max").
Query-Based Max/Min: You corrected the implementation of Max to simply query the underlying sorted index (O(1) read) rather than maintaining complex incremental state.
Math-Based Sum/Count: Use incremental math for invertible operations.


Additional details...

- This should be durable on top of tupledb.
- All indexes are explicitly named so they can be queried directly from tupledb.

