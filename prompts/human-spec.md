# Base Abstraction

The goal here is to design an app on top of tupledb with a solid architecture that generalizes well.

We already have TupleDb and SyncDb.

Let's keep things really really simple. No authentication or authorization for now, and lets focus on the data model. There's just two kinds of records.

```ts
type User = {type: "user", id: string, name: string}
type Message = {type: "message", id: string, from: string, to: string[], datetime: string, body: string}
```

We have a concept of an "AppDb" which is a lot like a SyncDb but doesn't keep track of a serialized history. It does keep track of transactions its seen though so that it's idempotent. The goal here is that this AppDb can scale out horizontally at some point whereas SyncDb is not capable of that.

The server exposes this AppDb and clients (aka browsers) can write or delete these records with basic set/delete operations.

```ts
const AppReducers = {
	set(tx: TupleDb, value: User | Message) {
		// ...
	},
	delete(tx: TupleDb, value: {type: string, id: string}) {
		// ...
	},
}
```

Each user is going to have their own syncDb and the appDb is going to fan out to each user.

Just to be clear, the UserReducers and the AppReducers don't have to be the same, but they also can be the same or similar. I'll make them explicitly different just to drive home the point, though in practice, it would probably be better to consolidate.

So when a user wants to send a message, the client creates a "set" operation to create the message object. This goes through the AppReducers which calls setMessage which then fans out those writes to the various syncDbs.

```ts
const UserReducers = {
	sendMessage(tx: TupleDb, value: Message) {
		// ...
	},
	receiveMessage(tx: TupleDb, value: Message) {
		// ...
	},
	deleteMessage(tx: TupleDb, id: string) {
		// ...
	},
	// ...
}

function setMessage(tx: TupleDb, message: Message) {
	syncDb(tx.subspace(["user", message.from]), UserReducers).write(ops => ops.sendMessage(message))
	for (const userId of userIds) {
		syncDb(tx.subspace(["user", userId]), UserReducers).write(ops => ops.recieveMessage(message))
	}
}

const AppReducers = {
	set(tx: TupleDb, value: User | Message) {
		if (value.type === "message") setMessage(tx, value)
		// ...
	},
	// ...
}
```

Inside the user syncDb, we have an inbox and an outbox. For now, we're going to manage the indexes manually, but in the future we'd probably use a "record layer" kind of thing to manage those indexes for us. This is absolutely fine for now though and we should not worry about indexing abstractions at this point and focus more on the realtime sync architecrure from client to server.

```ts
const UserReducers = {
	sendMessage(tx: TupleDb, value: Message) {
		tx.set(["message", value.id], value)
		tx.set(["outbox", value.datetime, value.id], null)
	},
	receiveMessage(tx: TupleDb, value: Message) {
		tx.set(["message", value.id], value)
		tx.set(["inbox", value.datetime, value.id], null)
	},
	deleteMessage(tx: TupleDb, id: string) {
		const message = tx.get(["message", value.id])
		tx.delete(["message", value.id])
		if (!message) return
		tx.delete(["outbox", value.datetime, value.id], null)
		tx.delete(["inbox", value.datetime, value.id], null)
	},
	// ...
}
```

Now we need to think more about what this "appDb" abstraction is and how it's exposed. Similar to syncDb, transactions consist of operations that can be derived from that reducer map.

```ts
type AppOp =
	| {fn: "set", args: [User | Message]}
	| {fn: "delete", args: [{type: string, id: string}]}

type AppCommit = {
	id: string // used for idempotency
	authorId?: string // used later for authorization
	createdAt: string // ISO string when the client created it
	ops: AppOps[]
}
```

Clients will construct these operations and submit them to the server. (note: clients will have their own local cache with optimistic updates and realtime pubsub subscriptions. But we'll get to that later.)

```ts
function appDb(db: TupleDb, reducers=AppReducers) {
	return {
		write(commit: AppCommit) {
			if (db.get(["seen", commit.id])) return	// Idempotency

			const tx = tupleTx(db)
			tx.set(["seen", commit.id], true)
			for (const op of commit.ops) reducers[op.fn](tx, op.args)
			tx.commit()
		}
		list: db.list,
	}
}
```

The read path from the client is fairly simple for now, it can just call `db.list(args)` to read ranges including the data, clocks, and history.

# Brainstorming

There are a few shortcomings of this abstraction as is and we'll think through those solutions incrementally below.
1. The reducers don't have access to the commit metadata like the authorId which are important for authorization.
2. The appDb doesn't have any clean way of triggering pubsub for clients to subscribe to realtime updates to syncDbs.
3. We haven't even talked about the client cache yet.

# Improvement: commit metadata

Commit metadata is basically anything that augments how the commit is processed.

For example, we might want to know the author of the commit for authorization, we might want to know at what time the commit is being recorded and at what time the client created the commit (there can be discrepancy due to offline editing). For example, we might want to record both the time the message as created by the client and the time it was actually sent by the server.

As for the commit id, I don't have the best use cases in mind. But I can imagine it being useful... For example, when an AppCommit writes to many different syncDbs, I think it makes sense if those syncDb commits all have the same transaction id so we can correlate those writes after the fact since remember, the AppCommit is not being saved in any kind of linear history. I can also imagine at some point if we wanted to build a high-level version control abstraction, then we'd definitely want access to those transaction ids for something.

```ts
type CommitMeta = {
	id: string
	authorId?: string
	createdAt: string
	commitedAt: string
}
```

From here, I think we just need to pass this metadata through to the reducers.

```ts
const AppReducers = {
	set(tx: TupleDb, commit: CommitMeta, args: User | Message) {
		// ...
	},
	delete(tx: TupleDb, commit: CommitMeta, args: {type: string, id: string}) {
		// ...
	},
}

const UserReducers = {
	sendMessage(tx: TupleDb, commit: CommitMeta, value: Message) {
		// ...
	},
	receiveMessage(tx: TupleDb, commit: CommitMeta, value: Message) {
		// ...
	},
	deleteMessage(tx: TupleDb, commit: CommitMeta, id: string) {
		// ...
	},
	// ...
}
```

And then we also need to make sure that we're specifying this metadata to the underlying syncdb.

```ts
function setMessage(tx: TupleDb, commit: CommitMeta, message: Message) {
	syncDb(tx.subspace(["user", message.from]), UserReducers).write(commit, ops => ops.sendMessage(message))
	for (const userId of userIds) {
		syncDb(tx.subspace(["user", userId]), UserReducers).write(commit, ops => ops.recieveMessage(message))
	}
}
```

This enabled us to do authorization isnide these reducers in the future.

```ts
const UserReducers = {
	sendMessage(tx: TupleDb, commit: CommitMeta, value: Message) {
		if (value.from !== commit.authorId) throw new AuthorizationError("You must be the author of a message to send it.")
		tx.set(["message", value.id], value)
		tx.set(["outbox", value.datetime, value.id], null)
	},
	// ...
}
```

One tricky part to mention is that clients don't include commitedAt timestamp, but that field is required once it ends up on the server. I think it's probably worthwhile to separate those types into two to be more typesafe and explicit. However, this could pose some challenges later with optimistic updates on the client... So perhaps it will be optional as is and we can assume it will only ever be undefined on the client...

# Improvement: pubsub

An important feature of this architecture is realtime updates between the client and the server over websockets. For the sake of performance and scalability, the pubsub channels are going to be unauthenticated and therefore the only data we're willing to leak is the clock values of syncDbs.

From the server's perspective, the pubsub api is really simple, its just a publish function.

```ts
type ServerPubsub = {
	publish(items: { key: string; value: any }[]): void
}
```

On the client, pubsub will have facilities for subscribing and listening.

```ts
export type ClientPubsub = {
	subscribe(key: string): void
	unsubscribe(key: string): void
	onMessage(listener: (key: string, value: any) => void): () => void
}
```

For the purpose of testing, we can build a simple abstraction that does all of this.

```ts
type TestPubsub = {
	publish(items: { key: string; value: any }[]): void
	subscribe(key: string): void
	unsubscribe(key: string): void
	onMessage(listener: (key: string, value: any) => void): () => void
}
```

Now for wiring it up into the AppDb... there are a few different approached we can take. One approach is just "fire and forget", but this can cause issues where things don't get emitted if there's a server crash after commit and before publish.

The most rock solid solution here is to actually write the publication to a queue in the database that then gets churned through by a separate process to fire the emits.

```ts
function publish(tx: TupleDb, commit: CommitMeta, key: Tuple) {
	if (commit.commitedAt === undefined) return // No need for this on the client.
	const value = tx.get(key)
	tx.set(["publish", commit.commitedAt, key], value)
}

function setMessage(tx: TupleDb, commit: CommitMeta, message: Message) {
	syncDb(tx.subspace(["user", message.from]), UserReducers).write(commit, ops => ops.sendMessage(message))
	publish(commit, ["user", message.from, "clock"])

	for (const userId of userIds) {
		syncDb(tx.subspace(["user", userId]), UserReducers).write(commit, ops => ops.recieveMessage(message))
		publish(commit, ["user", userId, "clock"])
	}
}
```

Then we can have a separate process that will dequeue and emit.

```ts
function processPublish(db: TupleDb, pubsub: Pubsub) {
	while (true) {
		const batch = db.subspace(["publish"]).list({limit: 100})
		if (batch.length === 0) return
		const items = batch.map(({key, value}) => ({key: key[1], value}))
		pubsub.publish(items)
		db.subspace(["publish"]).write({delete: batch.map(({key}) => key)})
	}
}
```

There are arbitrarily complex ways of writing this code so that we can have parallel workers, but this is simple enough for now and we might assume there's only one process writing at a time.

When we construct the appServer, we can just compose these things together like this.

```ts
function appServer(db: TupleDb, reducers, pubsub: Pubsub) {
	return {
		write(commit: Commit) {
			appDb(db, reducers).write(commit)
			processPublish(db, pubsub)
		}
		list: db.list
	}
}
```

# Brainstorming

- The syncDb abstraction feels a overly complicated. All it is is a write function and an assumed layout. What got me started thinking maybe this isnt right is the way that syncDb.write() created a transaction in there. That seems unnecessary most of the time because often times we're already going to be inside of a transaction. And so we can clear all of this out and it can just be a write function. `writeSyncDb(db, reducers, {id, authorId, createdAt, ops})`. And maybe it makes sense to keep the ops builder separate just so its cleaner separation of abstractions... `ops(reducers, op => op.whatever())`

- The client cache is missing a lot of clarity about how it works. It needs to write to the appDb, while subscribing to changes on the syncDbs and apply operations at both levels. Because the server is the authority which can modify what data is written, we need to make sure we're applying the updated data so the optimistic updates arent wrong and diverging.

- The last piece to consider is the record indexing layer. I think it makes sense to have two different abstractions here. One that is a simpler record indexing abstraction, and one that handles joins and aggregations and all of that ivm stuff. I think 90% of the time you can get away with simple record indexing so lets focus on that and ignore the ivm stuff. In fact, We can ignore all of this for now and just do indexing manually. The most important thing is to get the whole client/server sync and cache working together seamlessly.

# Improvement: simpler syncDb abstraction

The entire abstraction can just be a write function. And that write function doesnt need to create a transaction inside of it because it will be composed wherever it is needed just like all the other write function helpers.

```ts
function writeSyncDb(db, reducers, commit) {
	// ...
}
```

Of course the the ops builder is a convenient and typesafe way of building the ops list. And we can do that, but lets keep it as a separate abstraction that we can compose so we aren't polluting our abstractions.

```ts
function opBuilder<T>(build) {
	// ...
}

const ops = opBuilder<typeof reducers>(op => {
	op.doThis()
	op.toThat()
})
```

At the end of the day, the commit should be typed anyways based on those reducers. I don't might typing out the JSON for the commit operation anyways and we probably should avoid using the opBuilder function for now.

# Improvement: Client Cache

The existing implementation of the `TupleCache` seems like the underlying primitive on the client.

Lets make the assumption that the client (again, focusing on the browser), can only subscribe to data that's in a syncDb. That said, I can imagine having data indexed into other subspaces on the client and otherwise cached for search. For example, if a client wants to search for a username, that might be a standalone api endpoint and that data may get cached on the client with some TTL invalidation strategy. This data isnt "synced" and but it is cached.

Lets focus on the sycnDbs for now though. In fact, TodoMVC is probably the simplest place to start thinking about this because there's no need for "searching for usernames". Search is a unique problem solved separately. There are two strategies for TodoMVC.
1. A user's syncDb contains all of the todo lists.
2. Each todo list gets its own syncDb and the user's syncDb simply references those other todo lists.

I think we should think about how both of those situations work. The first approach is probably the simplest and most pragmatic, though the second example is a bit more general purpose and serves as a nice example for how to do writes across multiple syncdbs at once.

At the end of the day, we're going to be rendering with React, so we can start with those hooks and work backwards...

```tsx
function TodoList(props: {id: string}) {
	const [filter, setFilter] = useState<"all"| "checked" | "unchecked">("all")

	const todoList = useSyncDb(cache, ["todoList", props.id]) // subscribe to clock key from server pubsub.
	const {local, remote} = useList(todoList.subspace([filter]), {limit: 20}) // subscribe to data range, fetch, and keep in sync

	if (local.miss) return <div>Loading...</div>
	const todos = local.hit || local.prefix

// Assuming the indexes have a null value and a todoId at the end:
	// ["all", order, todoId]
	// ["checked", order, todoId]
	// ["unchecked", order, todoId]

	const todoIds = todos.map(({key}) => key.at(-1))

	return <div>{todoIds.map(todoId => <Todo listId={props.id} todoId={todoId}/>)</div>
}
```

In that example, `useSyncDb` gets a path. Using a global cache, it checks if we have that data in there. It subscribe to changes from the server via pubsub and subscribes to changes within the cache locally too. It fetches data if it doesnt exist and inserts it into the cache.

```tsx
function Todo(props: {listId, todoId}) {

	const todoList = useSyncDb(cache, ["todoList", props.listId])
	const {local, remote} = useGet(todoList, ["todo", props.todoId])
	if (!local) return <div>Loading...</div>
	// Note: we could throw remote as well if we wanted to use Suspense since remote is a promise.
	const todoItem = local

	// These appReducers help with types for the write function, but they also contain the logic for
	// optimistic updates. It's assumed here that appReducers will look at which list the todoItem belongs to
	// and call the todoReducers on that syncDb.

	const setChecked = (checked: boolean) =>
		write(cache, appReducers, {
			id: randomId()
			createdAt: new Date().toISOString(),
			ops: [{fn: "set", args: [{...todoItem, checked}]}]
		})

	return <div>...</div>
}
```

It's important that the write method here isn't on the syncDb using to todoReducers... It's very tempting to do that though but that short circuits things and makes it challenging to do transactional commits across multiple syncDbs.

Lets assume right now the schema looks something like

```ts
["user", userId, "clock"]
["user", userId, "history"]
["user", userId, "data", "todoList", "list", order, listId]
["user", userId, "data", "todoList", "map", listId, order]


["todoList", listId, "clock"]
["todoList", listId, "history"]
["todoList", listId, "data"]: TodoList (just a name for now)
["todoList", listId, "data", "todo", id]: Todo
// I can imagine order in this case is just the most recent editedAt time just to keep things simple.
["todoList", listId, "data", "all", order, id]
["todoList", listId, "data", "checked", order, id]
["todoList", listId, "data", "unchecked", order, id]
```

So there's a "syncDb" at `["user", userId]` and at some point we can imagine a "hashList" abstraction at `["user", userId, "data", "todoList"]` within the user's syncDb which uses fractional indexing to insert items.


```ts
const appReducers = {
	newList(tx: TupleDb, commit: CommitMeta, id: string, name: string) {
		if (!commit.authorId) throw new AuthorizationError("You need to be logged in.")

		const userDb = tx.subspace(["user", commit.authorId])

		const [{key}] = userDb.subspace(["todoLists", "list"]).list({limit: 1})
		const order = generateKeyBetween(null, key[0]) // using npm "fractional-indexing" package

		writeSyncDb(userDb, userReducers, {...commit, ops: [
			{fn: "insertList", args: [order, id]}
		]})

		const listDb = tx.subspace(["todoList", id])
		writeSyncDb(listDb, todoListReducers, {...commit, ops: [
			{fn: "createList", args: [{id, name}]}
		]})

		publish(tx, ["user", commit.authorId])
		publish(tx, ["todoList", id])
	}
	// ...
}
```

Just to recap whats going on there... Clients can create a new todo list. Its going to use the commit author to determine who the list belongs to. It's going to insert the list into the user's syncDb, and its also going to create the list object in the list syncDb so we have the name of the list saved for the todoList record. So using the app-level commit operations, we're able to write to both sync dbs in the same transaction.

Lists are a challenge in themselves with tupleDb and I hinted at some abstractions we could use later. But for now, lets keep it simple.

I think this client side api could use a bit of massaging but its mostly there in terms of the API.

Lets get a little more detailed on the read path and the write path.

## Read Path

Inside `useSyncDb`, we're going to subscribe to that syncDb path's clock over pubsub. Since we might have multiple components subscribed to the same path, we just need to reference count and only unsubscribe once the reference gets back down to zero.

```ts
useEffect(() => {
	subscriptions.inc(path)
	return () => subscriptions.dec(path)
}, [path])
```

Then inside `useList` we're going to read from the local cache to see if that data is there in range returning {hit, miss, prefix} type. If the local result isnt `hit` then we're going to fire an api request to retrieve that range from the server and put it into the cache using `cache.insert`. Meanwhile we're going to use `cache.subscribe` to subscribe to the local cache value of that range so that the UI can update automatically when the result responds.

NOTE: when we call `api.list` to get the data range, we also need to get the clock value for that syncDb so that we can be up to date on history to make sure everything is consistent.

When we call useList, the range that we record that we're listening should have a reference count as well so we can clear out ranges we no longer care about once the reference on a range drops to zero.

## Write Path

`write` needs to handle queueing up writes to the server. Writes should always be submitted in order so there should be a queue here. And one day when things work offline, that queue will get persisted. One day, we may consider throttling the writes into batches. But for now, we can keep that queue in memory.

We want writes to be applied optimistically to the client cache immediately, then the server will process the writes. The server will emit a clock via pubsub, and various clients will sync those changes. As for the client that made the write, it can call sync immediately after the write to get updated history state.

The client needs to keep track of which transactions are yet to be written, the clock for the data that's come from the server, and a layer on top with all the optimistic changes. So when we get a clock update, we should compare that clock with the synced underlying database, not the optimsitic layer on top. We can then fetch whatever history we're missing, apply those changes locally, discard any writes outside the currently subscribed ranges, then we can use the transation id to figure out what what remaining transactions are still to be applied on top optimistically and have yet to be synced. This part is a bit tricky and could use a more detailed description and analysis for how it works.xw

Something to clarify about the above situation. When we write on the server, the publish record tells us what clocks just updates on account of that transaction. Those clock updates can be returned by the request so the client knows exactly what syncDbs to sync.

# Improvement: Waterfall Fetching

It's common in frontend heavy applications like this that we end up doing a lot of fetching of lists and then mapping over those lists to fetch the items. The classic N+1 waterfall. This probably isn't such a big deal if we thoughtfully fetch data ahead of time. But an elegant way of dealing with this is to create custom API endpoints that return a set of data ranges that you can insert wholesale into the cache. This is the purpose of the ReadCache (already implemented). The api can just return the list args and the results and then the client just needs to insert them. Pretty simple.

# Future Roadmap

That covers the bare necessities to get this system up and running. And I want to focus on keeping things simple, concise, and composable. It's important to see where things are headed to ensure the system is designed with those capabilities in mind, as well as avoiding doing things that we simply don't need to worry about yet.

- better record layer indexing abstraction. The existing recordDb implementation probably does more than we need for most things. I think its common that people will want to just have record indexes and maybe the occasional join or aggregation index. Join and aggregation indexes are much harder to reason about in this world of eventual consistency and partial caching. So I think its fine to kick that can down the road. Furthermore, it's possible that operations become more generic and less semantic. Instead of "newList", it will just be a bunch of "set" operations. We can have delete operations, maybe some update json path, or incement operations too. Making things generic like this can lead to a more concise abstraction around the app reducers vs the various syncdb reducers, eliminating the need to semantically specify all of that. Though, that work tends to get passed on to figuring out how to validate it all and how to present that as a historical log to the user.  Either way, just somethign to think about.
- a simple set of hashList functions that do some read/write/insert operations with fractional indexing.
- a simple method of replicating a syncDb. You can imagine a situation where a syncDb is the entire db that you care about and the appReducers are the syncDb reducers -- the entire db is the syncDb. In this case, things are a little simpler but less generic. The appDb layer is essentially just a passthrough. We should be able to support both situations. And in this case, being able to fully replicate one db to another location with a set of functions seems useful. Especially if we can have realtime replication using pubsub or some other kind of straight websocket api with a polling fallback. This is nice for copying data from one place to another (with shell commands) or for creating realtime backups in multiple locations.
- building on the fully replicated abstraction, we can consider some p2p abstractions. All we really need to do is fiddle with the clock so tht it contains the userId as well. Then we need to write a sync function and then we have p2p sync working. I think its important to see how p2p sync is useful in some ways and not in others. p2p sync involves maintaining a full history and so this is never going to be great for browser clients. However, if you wanted a proper local-first app, then maybe your main process would maintain a full history that is p2p synced. However, the actual browser client will still only want some portion of that database in-memory and would offload all of the sync to another process.







TODO:
- replication and p2p sync
- convneient way of working with isolated syncdbs, a passthrough appdb