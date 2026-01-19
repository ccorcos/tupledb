
## SyncDb
I want to build a simple way of syncing data between client and server. The idea is that anything that gets sync'd must have a logical clock, a history, and an okv. The history contains a set of operations (set, delete, update, insert, etc.) which modify the tupleDb. The server is the authority but the client should be able to optimistically update and work offline.

The underlying implementation on both the client and the server is a set of types and functions for processing operations to write to the tupleDb. Importantly, when those operations are processed, we need to update the clock and history appropriately and enqueue dispatching an update for clients to trigger a sync.

For example, this is what I want the developer experience to feel like when processing operations.

function sendMessage(tx, message) {
	for (const person of message.recipients)
		syncDb(tx.subspace(["person", person])).set(["inbox", message.id], message)
}

On the client, we want to reuse much of the logic from @src/tupleDb/Cache.test.ts to keep track of what ranges we've actualy read within each syncDb. We also need the reactivity layer, and need the ability to sync with the server to pull down new operations. After applying the operations on the client which should denormalize into the various indexes, we can prune out any writes to indexes that we aren't subscribed to.

The client api should feel something like...

```tsx
const userDb = useSyncDb(db, ["user", id])
const inbox = useList(userDb, ["inbox"], {gte: "2020-01-01", limit: 20})
if (inbox.miss) return <div>loading</div>
const messages = inbox.hit || inbox.prefix
```

And then to write, its a matter of pushing operations.

```ts
db.write({fn: "sendMessage", args: [{id, recipients, body}]})
```

We also need to be able to inspect history so we can render it and know whether or not the history is optimistic or has been successfully written to the server.

I've written some existing logic in  @src/tupleDb/SyncDb.ts but its still pretty minimal and doesnt include any API logic for actual syncing and isnt integrated with the cachen either.

Please write docs/sync-plan.md with a planf ro how we should do this. Think very carefully about the developer experience and API for using this. Mock and test the async interface with the server with request failure tolerance. And make sure the cache tracks things correctly, purges unused data, and handles syncing upon reconnection.

---

This looks like a great start. But it doesn’t quite fulfill the entire goal I’m looking for. The client is going to have many syncDbs that it’s subscribed to all at once. I don’t want to have duplicates of the same database / subscription either. So I want to have a global coordination of all of this. Ideally all the data lives in the same tupledb cache and we coordinate all the subscriptions (syncDb) separately in a global store and go from there. So basically the sync client is more like a Map of SyncClients. And I'd like to have a single underlying cache so that the data is all stored in one place that matches perfectly with the server version of the database.

---

@src/tupleDb/SyncDb.ts @src/tupleDb/sync/


I have some ideas for improvement here but it doesnt entirely fit together. Help me figure this out. Lets take a step by step approach and carefully consider the API. I want things to light and simple and composable rather than a mega api that wraps everything and obscures whats going on under the hood.


```ts
type User = {type: "user", id: string, name?: string, bio?: string, age?: number}
type Message = {type: "message", id: string, fromId: string, toId: string[], createdAt: string, body: string}

type Operation =
	| {fn: "set", args: [User | Message]}
	| {fn: "delete", args: [{type: string, id: string}]}

type ClientTransaction = {
	id: string,
	authorId?: string
	createdAt: string,
	operations: Operation[],
}

type ServerTransaction = {
	id: string,
	clock: number
	authorId?: string
	createdAt: string,
	committedAt: string
	operations: Operation[],
}

const reducers = {
	set: (tx: TupleDb, obj: User | Message, authorId?: string) => {
		if (authorId === undefined) throw new ValidationError("You must be logged in.")

		if (obj.type === "user") {
			VALIDATION: {
				if (authorId === adminId) break VALIDATION
				if (authorId !== obj.id) throw new ValidationError("You can only edit the current user.")
			}

			// Track history for the specific user.
			const userDb = syncDb(tx.subspace(["user", obj.id]))
			// The top level key is just the user.
			userDb.set([], obj)
			return
		}

		if (obj.type === "message") {
			VALIDATION: {
				if (authorId === adminId) break VALIDATION
				if (authorId !== obj.fromId) throw new ValidationError("You must be the author of the mesage.")
			}

			// Track history for the specific user.
			const authorDb = syncDb(tx.subspace(["user", obj.fromId]))
			authorDb.set(["sent", obj.datetime, obj.id], obj)
			for (const userId of obj.toId) {
				const userDb = syncDb(tx.subspace(["user", toId]))
				userDb.set(["inbox", obj.datetime, obj.id], obj)
			}
			return
		}
	}
	delete: () => {}
}


const serverApi = {
	list(args: ListArgs) {
		// TODO: permissions based on subspaces
		return db.list(args)
	}
	write(transactions: ClientTransaction[]) {
		// Write using the reducers.
	}
}

// Clients can query the db directly with the list method.
// Clients can sync history by listing history for a specific syncDb after a certain clock.

```

There are a few piece that don't fit together yet that we need to think about...

1. Client transactions get fragmented across many syncDb histories and in a way that not all operations in a single client transaction should be visible to each syncDb. So there end up being many ServerTransactions that live in separate syncdb histories but still have the same underlying transaction id because it emanated from the same client transaction. Perhaps we can track this somehow, but it's not particularly important right now. The question is how we make sure the client transactoin information ends up in the history or eazch sycnDb we write to...

2. I like how the list api generalizes really well allowing for clients to sync. However, there's going to be some tricky things where a client might be out of date when they read and so every read probably needs to be from a syncDb and return a clock value and any new history as well. I think we can generalize this to some extent where this method returns a set of tuples, some of which may occur from outside the requested range (such as history and clock value). And that could make this whole thing work...

---

So this is closer... Lets focus on the write path for now and deal with the read path next.

I don't think the syncDb history should lose the semantics of the operations though... My example had set and delete but the goal wasnt for SyncHistoryEntry changes to jsut be WriteArgs. However, I do want to be able to replay history... So lets reformulate the example a little bit.


```ts
// Lets make it more clear that these operations are semantic and we can choose them however we want.
// We may choose a more general pattern with just set and delete, but we can have anything here.
type Operation =
	| {fn: "updateUser", args: [{id: string, name?: string, bio?: string, age?: number}]}
	| {fn: "sendMessage", args: [Message]}
	| {fn: "deleteMessage", args: [{id: string}]}


// These reducers for the user syncDbs
const userReducers = (userId: string) => ({
	sendMessage: (tx: TupleDb, msg: Message) => {
		if (msg.fromId === userId) {
			tx.set(["sent", msg.datetime, msg.id], msg)
		} else {
			tx.set(["inbox", msg.datetime, msg.id], msg)
		}
	}
})


// These reducers aren't actually associated with a syncDb necessarily and could just be used for
// performing the operations. Interestingly, we could have a syncDb inside a syncDb now and have a
// global database history if we wanted.
const serverReducers = (authorId) => ({
	sendMessage: (tx: TupleDb, msg: Message) => {
		// after validation stuff....
		const authorDb = syncDb(tx.subspace(["user", obj.fromId]), userReducers(obj.fromId))
		authorDb.sendMessage(msg)

		for (const userId of obj.toId) {
			const userDb = syncDb(tx.subspace(["user", toId]), userReducers(toId))
			authorDb.sendMessage(msg)
		}
	}
})


const serverApi = {
	write(transactions: ClientTransaction[]) {
		// Write using the reducers.
		const tx = tupleTx(db)
		const reducers = serverReducers(currentAuthorId)
		for (const tx of transactions) for (const op of tx.operations) reducers[op.fn](tx, ...op.args)
		tx.commit()
	},
}

```

I feel like that's pretty good for the write side of things. We still need to plumb some of the transaction metadata through there though.

On the client, we can use those same reducers for optimistic writes and processing sync updates.

---

Now for the syncDb read path...

The client needs to support "partial sync". And what I mean by this is the client doesnt need to maintain the entire history and the entire subspace of a syncDb in order to work.

In our example we've been running with, a user's syncDb has the following layout in the tupleDb:

```ts
["user", id, "clock"]: number
["user", id, "history", clock]: Transaction
["user", id, "data"]: User
["user", id, "data", "sent", datetime, id]: Message
["user", id, "data", "inbox", datetime, id]: Message
```

A user should be able to query only a partial set of this data. For example, the first 10 messages in their inbox, or some arbitrary range of history (not for sync but just to view a log of edits).

When the user reads this data from inside a syncDb like this though, we need to make sure that the cache is consistent. Imagine a situation where the client cache is on clock 20 with 5 optimistic writes on top. And the server is on clock 30. When the user reads from the server range, the client needs to first write those 10 updates, the commit the range that was read into the cache, and the run the 5 optimistic writes on top... Somethign like that needs to happen so that we maintain a valid cache state that will be eventually consistent.

So to reiterate, the client cache definitely needs to know the server clock for syncing. But it doesnt need the entire history and entire data subspaces. It can read various ranges of either the data or history subspace for the take of rendering. It maintains optimistic history writes, clock, and data on top of the known synced values from the server. And it keeps track of what ranges are actually in the cache. And when we sync and writes come in from history, we will apply those to the cache while also discarding and writes that end up outside of the ranges that we're currently keeping around to look at. This goes along with our cache invalidation strategy that removes data from ranges we're no longer subscribed to on the client. And it would be prudent to unsubscribe with a 1m delay in case we re-subscribe to those ranges.

Note that there are two different concepts of subscription now.
1. The browser client can subscribe to a syncDb clock/history subspace. This simply listens for a clock update and pulls down history to apply it locally.
2. Inside the browser client is a cache with data ranges and the react components can subscribe to various data ranges that get fetched fom the server if they aren't there. And when data changes in those ranges, those components update. One day we'll optimize this reactivity model with an interval tree.

---

Let's streamline the syncDb api a little bit...

history() should have the same api as list() just on a different subspace. This allows the ability to inspect arbitrary ranges of the history and keeps a general api.

subspace() only seems useful for read methods. So that can reduce to a ReadOnlyTupleDb.

In terms of writes, I don't think we should merge the default reducers with that reducers we pass in. The only writes available are the reducers and perhaps if they're undefined they can default to {set, delete} (and lets just get rid of write for now). This way the abstraction is nice and tight and explicit.

writeSyncOp seems like an unncessary complication / abstraction. We dont need to export it, and the executor thing at the end is just a twisted composition. Lets flatten that out and simply it.

Now looking at the SyncServer...

I don't like the way these functions are named and how things bundle through these json SyncRequest types...

The sync server should just have {read, write} and possibly a {sync} which just composes those two things.

The client can basically call those function directly but there will be a promise in the middle but the network will be seamlessly be abstracted away. However, networks can error so we need to handle that. Perhaps we need to manage whether the user is offline and differnet kinds of errors such as writes getting rejected for one reason or another. I can also imagine the server re-writing some of the data like putting a server timestamp in there or some other server authority override. So lets handle that as well.


---

@src/tupleDb/SyncDb.ts @src/tupleDb/sync/


Lets refactor some of the language we're using and tidy up some of the types. Here's what I want.

```ts
export type CommitMetadata = {
	id: string
	authorId?: string // Used for authorization.
	createdAt: string // ISO string when the client created it
}

export type Reducer = (tx: TupleDb, args: any) => void
export type ReducerMap = Record<string, Reducer>
export type Op = { fn: string; args: any }

export type CommitData = {
	clock: number
	commitedAt: string // ISO string when the server wrote it to the database
	ops: Op[]
}

export type Commit = CommitMetadata & CommitData

type WriteSyncDb<R extends ReducerMap> = {
	[K in keyof R]: (args: Parameters<R[K]>[1]) => void
}

export type SyncDb<R extends ReducerMap> = {
	clock: () => number
	history: ReadOnlyTupleDb
	data: ReadOnlyTupleDb & WriteSyncDb<R>
}
```

Lets move src/tupleDb/SyncDb.ts and src/tupleDb/SyncDb.test.ts into src/tupleDb/sync directory. And we need to either rename or consolidate the name conflict with src/tupleDb/sync/SyncDb.test.ts which already exists.


Lets also add types for SyncClient and SyncServer in types.ts

---

class SyncServer doesnt have to be a class, just a function. I try to only uses classes when there's state held on that object, and avoid using them when its just gluing things together like we are in SyncServer. Please document this pattern in docs/code-style.md.

Lets also avoid using any when we have type available that works. Like the dataWrapper: any

---


Lets flatten out the write abstraction on SyncDb.

This is what it was before.
export type SyncDb<R extends ReducerMap> = {
	clock: () => number
	history: ReadOnlyTupleDb
	data: ReadOnlyTupleDb & WriteSyncDb<R>
}

After I want to to be more like this:
export type SyncDb<R extends ReducerMap> = {
	clock: () => number
	history: ReadOnlyTupleDb
	data: ReadOnlyTupleDb
} & WriteSyncDb<R>


Metadata for writes is happening in the wrong place. We shouldn't pass the tx metadata when constructing the syncDb. It should be on write. Lets implement something like this.

const userDb = syncDb(db.subspace(["user", userId]), userReducers)
const historyItem = userDb.write({...metadata, ops})

Or we can use a transaction style for more ergonomic and typed usage.
const tx = syncTx(userDb, metadata)
tx.sendMessage({...})
tx.commit()


I want to think about how to sync to a full replica. We're using logical replication...

const db1 = syncDb(a)
const db2 = syncDb(b)

function replicate() {
	const history = db1.history({gt: [db2.clock()]})
	for (const item of history) db2.write(item)
}

This feels pretty clean. However, write needs to handle two different functionalities. If the argument is a client transaciton, it needs to fill in the commitedAt and the clock value and return the actual history item after potentially modifying the data. However, if the clock value is there, then we can assume this is a server transaction and we should throw an error if that values are off...

Syncing to a partial replica required using the sync client and the underlying cache. This is a bit trickier because we need to handle optimistic writes.

---

More changes to syncdb types.

Flatten out the types more like this

export type CommitArgs = {
	id?: string
	authorId?: string
	createdAt?: string
	ops: Op[]
}

export type Commit = {
	id: string
	authorId?: string // Used for authorization.
	createdAt: string // ISO string when the client created it
	clock: number
	commitedAt: string // ISO string when the server wrote it to the database
	ops: Op[]
}

Op should and commit should probably be generic to the reducer map so the types work. Give it any type default though so its easy to use.


Then we can simplify syncDb a lot like this.

export type SyncDb<R extends ReducerMap> = {
	clock: () => number
	history: ReadOnlyTupleDb
	data: ReadOnlyTupleDb
	write: (commit: CommitArgs<R> | Commit<R>) => Commit
}

This clean up the abstraction to a more minimal form.

---

Lets change the api for syncDb.write a little bit.

Lets provide an ergonomic option with a callback for building these ops.

use.write({id: "1234", authorId: "1234"}, ops => {
	ops.set(["a], 1)
	ops.set(["b], 2)
	ops.delete(["c])
})

---


Lets massage these abstractions a bit.


First, for the sake of reactivity, there are two components to the server api. There's the read/write kinds of http methods, as well as a pub/sub kind of websocket api so we can actively push and listen for changes.

Pubsub is a generic utility, but in practice, the server is only going to publish clock values and the clients will subscribe to those clocks.

```ts
type Pubsub = {
	publish(tuple: Tuple, value: JSONValue): void
	subscribe(tuple: Tuple): void
	onMessage(listener: (tuple: Tuple, value: JSONValue) => void): () => void
}
```

We'll rename SyncManager to SyncCache and its going to look something like this.

```ts
type TupleCache = Cache<Tuple, JSONValue>

class SyncCache {

	cache: TupleCache

	constructor(args: {
		api: SyncServer
		pubsub: Pubsub
	})

	// ...
}
```

In terms of actually using it on the frontend, it should look something like this:

```ts
const cache = new SyncCache({api, pubsub})

// Specify a path
const user = cache.syncDb(["user", "user1"], userReducers)

// Range query
const {local, remote, unsubscribe} = user.data.subscribe({gt, lt}, ({hit, miss, prefix}) => {
	// Update...
	// Note: this can be called from remote data syncing or from optimistic local updates.
})

const {hit, miss, prefix} = local // immediate local results in the cache
const items = await remote // if you want to await the request to the server
unsubscribe() // decrement references to retaining this range in the cache and possibly unsubscribe from remote clock.

user.history.subscribe() // works the same as user.data.subscribe
user.pending.list() // tells about local pending writes that go on top of history.

user.write({...}, ops => ops.sendMessage(msg))
```

Please implement this, being thoughtful about constructing the types, and making sure there's tests.

---

SyncClient seems a bit long and messy.

Lets create types for SyncCache and ClientSyncDb into synDb/types.ts so we have well understood abstracitons to work with.

It seems like TupleCache is worthy of its own abstraction. Then we can call subspace() on that tuple cache which should simplify a lot of things in the ClientSyncDb.

I don't like how the ClientSyncDb has a full referecent to the SyncCache though. Ideally, we should pass a well defined interface there.

---

I like the idea of keeping the okv cache to a minimal api.

1. we can consolidate insert and apply. insert is more general than apply because it can handle ranges. however we should probably add a couple optimizations. (a) insert should accept a batch. insert(ranges: {args: ListArgs, items: {key, value}[]}[]), that way we can write multiple matches in a single transaction and a single call to emit which allows us to deduplicate emits. (b) we can check if the list args range is lte equals gte, and skip the read step since it will just overwrite, and we can check result.length === 0 for a delete vs a set. This makes things a little more efficient for writing single items.

2. now we can have a simple help function writeToInsert(changes: WriteArgs): {args: ListArgs, items: {key, value}[]}[] so that we can get rid of the apply function but use this helper to map its args into insert.

3. I think we can also get rid of listRaw. It feels like an antipattern. We should always be considering whether the data is actually in the cache or not when reading.

Lets propagate all those changes to TupleCache and everywhere else its used.

export type OkvCache<K, V> = {
	insert: (ranges: {args: ListArgs<K>, result: { key: K; value: V }[]}[]) => void
	compare: (a: K, b: K) => number
	list: (args: ListArgs<K>) => CacheListResult<K, V>
	write: (args: WriteArgs<K, V>) => () => void
	subscribe: (range: Range<K>, fn: () => void) => () => void
}


❯❯❯ tree src
src
├── recordDb
│   ├── RecordLayer.fuzz.test.ts
│   ├── RecordLayer.test.ts
│   └── RecordLayer.ts
├── shared
│   ├── compactObj.ts
│   ├── compare.ts
│   ├── OrderedList.ts
│   ├── randomId.ts
│   └── reverse.ts
├── syncDb
│   ├── react.ts
│   ├── SyncClient.ts
│   ├── SyncDb.test.ts
│   ├── SyncDb.ts
│   ├── SyncExample.test.ts
│   ├── SyncIntegration.test.ts
│   ├── SyncServer.ts
│   └── types.ts
└── tupleDb
    ├── Codec.ts
    ├── Encoder.ts
    ├── InMemoryOkv.ts
    ├── OkvCache.test.ts
    ├── OkvCache.ts
    ├── Range.test.ts
    ├── Range.ts
    ├── RangeEmitter.ts
    ├── RangeTree.test.ts
    ├── RangeTree.ts
    ├── ReadCache.ts
    ├── SQLiteOkv.ts
    ├── Transaction.test.ts
    ├── Transaction.ts
    ├── TupleCache.ts
    ├── TupleDb.test.ts
    ├── TupleDb.ts
    └── types.ts

---



We need to think about where the "operation" write types live...
- on one hand, it lives in the sync history for each object.
- on the other hand, there should be just a single write api from the client which fans out to the various sync dbs.

It seems like we should have a global syncDb with syncDbs inside. The global syncDb can be "shallow" in the sense that it doesn't need to keep a clock or history or publish clocks to pubsub. It's just an abstraction for the write path which fans out to the inner syncDbs which are not shallow.

Then inside SyncClient.ts... SyncCache is a unification of {api, pubsub, cache, reducers}. It manages all the state, pending writes, what needs to get synced with the server, what syncdbs we're listening to and when to purge them from the cache. I don't like how ClientSyncDb contains so much state. It shouldn't have any state and instead the state is held by SyncCache.

I'm imagining two different places where sync db abstraction is used in the client. When we're syncing changes from the server, we're receiving just the changes for each syncdb and we'll want to apply those to the local sync dbs. However, the client shouldn't be commiting writes to the indicidual syncdbs -- those should generally be readonly, and the client should be commiting writes to the global syncdb so that the server can fanout those writes appropriately (as well as optimistically fan them out locally).

This feels like the right way of doing things.

const client = new SyncClient({api, pubsub, cache, reducers})
client.write({authorId: "1234"}, ops => ops.doGlobalWrite())

For optimistic updates, the reducers will map into the relevant syncDbs...

const reducers = {
	doGlobalWrite(tx, args) {
		const thing = syncDb(tx.subspace([whatever]))
		things.write(ops => ops.doLocalWrite())
	}
}

There's some tricky stuff to figure out here though.
- that's an optimistic pending write, not an actual write. the metadata should reflect this, and for a specific syncDb, we should see pending writes just for that syncDb scope.
- we also need to handle the case where the data we're fetching as part of a read-write operation, need to make sure that the data is actually in the cache. If the data is not in the cache, then the operation may thing that the data does not exist which could change the behavior, especially if its an upsert. And so if we read outside the range that exists in the cache, we probably want to avoid doing that optimistic write, though we still want ot see the operation as pending...

As for the server side, things are a bit more straightforward. We get operations for the global reducers, apply them, and then publish all the clock updates.

---


I want to brainstorm two examples, end to end, using tupledb, syncdb, and eventually recorddb too.

Create SyncExample1.test.ts and SyncExample2.test.ts to demonstrate these ideas. Include detailed comments about how each example works and its intended architecture so that future iterations can stay true to the purpose.

Example 1: A chat app where users get their own subspaces and everything fans out entirely on the backend. There's only one syncdb on the client. Client submits operations on the syncdb, the server applies those operations and fans out to all the users. Users are only subscribed to a single user syncDb subspace so there's only one clock to listen to there.
Example 2: A chat app where each chatroom gets their own syncdb as well as a user syncDb for managing user information and lists of chatrooms, etc. In this case, the client submit operations on the different syncDb can can transactionally commit operations across multiple syncDbs at once. The server gets those operations and applied them as you'd expect. Clients end up subscribing to more than one syncDb clock.

We don't need to actually build a UI or an http server, but we should model the client and server as if there was a network in between which could error, and reactivity in the client suitable for rendering updates in realtime.

Make sure you architect things succintly and deliberately in the types.ts files so we have well defined abstractions and interfaces.

We can start by modeling operations as a very simple set or delete operation to upsert or delete an object. Lets focus on only three object types, users, messages, and user profiles.

In example 1, when a user profile is edited, it will fan out to any users who have correspondence with them. In example 2, the users actually subscribe to profiles directly.
In example 1, when a message is created, it will fan out to every user syncDb. In example 2, when a message is created it ends up in a "chatroom" syncdb. This required a new data type and a slightly different data model. Chatrooms define who belongs to them, not messages. The messages to field is just the chatroom.
In example 1, a client just subscribes to the logged in user and thats pretty much it. In example 2, a client subscribes to the user and queries for what chatrooms theyre apart of and then subscribed to those chatrooms individually.


For now, lets focus on keeping things simple with operations with the foresight that we will eventually want to use recordDb-style ivm within each syncDb for managing indexing.

Please come up with a plan for how to implement all of this. Be explicit about the types and decisions trade-offs. Consider how to make the abstraction as clean, pure, functional, and explicit as possible. Include examples of what the final abstraction should feel like to use in real-world examples. Document the plan in docs/sync-examples.md

---

This all feels way off. Lets focus on the abstraction and the documentation and don't write any more code until we figure it out. Continue writing in the sync-examples.md file... The server is simple. Its a database, api, and pubsub. The database has a way of accpeting write operations, applying operations, publishing clocks, and an api for reading/writing. The client has a cache and the client developer experience should just be something as simple as getting a syncDb path from the cache and querying it. The response should say whether oits in the cache or not and fetch things in the background and reactively call the callback in the query saying there's changes. Clients should have to unsubscribe explicitly to free the reference counter from the cache. The cache also needs to handle optimistic updating by applying operations and keeping a queue of outbound writes to send to the server to reconcile.

---

I've create cleaned up the src/syncDb abstractions and created an example HumanTodoMVC.test.ts

@src/syncDb/examples/HumanTodoMVC.test.ts

Please refactor to use those abstractions.

I don't like the way src/fixtures/TestHarness.ts works because it's not using real abstractions that will be used in production. I like the HumanTodoMVC approach more.

The FetchApi and the AppDb abstraction are be unified into a single api abstraction in HumanTodoMVC.

SyncServer.ts seems unnecessary with the abstractions in HumanTodoMVC.

It seems that the entire syncDb/SyncDb.ts abstraction is gone too and we're just going to use applySyncCommit.

Please clean everything up to align with the abstractions in HumanTodoMVC.test.ts. Get rid of all the cruft. And make sure you address the following files as well:

src/syncDb/SyncClient.test.ts
src/syncDb/SyncClient.ts
src/syncDb/SyncDb.test.ts
src/syncDb/SyncDb.ts
src/syncDb/examples/Messaging.test.ts
src/syncDb/examples/Messaging.ts
src/syncDb/examples/TodoMVC.test.ts
src/syncDb/examples/TodoMVC.ts

---

Lets write some tests for src/examples/TodoMVC.ts Lets make sure to cover the following basics: create a list, delete a list, update the list name, create todo, delete a todo, rename a todo, check a todo, reorder a todo, updating a todo should update the list editedAt. We should verify action order in the history.

Make sure your testing code is well factored and very readable. Use whatever helper functions and abstractions necessary to do a good job.

