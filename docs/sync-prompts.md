
## SyncDb
I want to build a simple way of syncing data between client and server. The idea is that anything that gets sync'd must have a logical clock, a history, and an okv. The history contains a set of operations (set, delete, update, insert, etc.) which modify the tupleDb. The server is the authority but the client should be able to optimistically update and work offline.

The underlying implementation on both the client and the server is a set of types and functions for processing operations to write to the tupleDb. Importantly, when those operations are processed, we need to update the clock and history appropriately and enqueue dispatching an update for clients to trigger a sync.

For example, this is what I want the developer experience to feel like when processing operations.

function sendMessage(tx, message) {
	for (const person of message.recipients)
		syncDb(tx.subspace(["person", person])).set(["inbox", message.id], message)
}

On the client, we want to reuse much of the logic from @src/tupledb/Cache.test.ts to keep track of what ranges we've actualy read within each syncDb. We also need the reactivity layer, and need the ability to sync with the server to pull down new operations. After applying the operations on the client which should denormalize into the various indexes, we can prune out any writes to indexes that we aren't subscribed to.

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

I've written some existing logic in  @src/tupledb/SyncDb.ts but its still pretty minimal and doesnt include any API logic for actual syncing and isnt integrated with the cachen either.

Please write docs/sync-plan.md with a planf ro how we should do this. Think very carefully about the developer experience and API for using this. Mock and test the async interface with the server with request failure tolerance. And make sure the cache tracks things correctly, purges unused data, and handles syncing upon reconnection.

---

This looks like a great start. But it doesn’t quite fulfill the entire goal I’m looking for. The client is going to have many syncDbs that it’s subscribed to all at once. I don’t want to have duplicates of the same database / subscription either. So I want to have a global coordination of all of this. Ideally all the data lives in the same tupledb cache and we coordinate all the subscriptions (syncDb) separately in a global store and go from there. So basically the sync client is more like a Map of SyncClients. And I'd like to have a single underlying cache so that the data is all stored in one place that matches perfectly with the server version of the database.

---

@src/tupledb/SyncDb.ts @src/tupledb/sync/


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

