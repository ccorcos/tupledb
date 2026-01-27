
HERE: HumanTodoMVC


- make some simple tests for humantodomvc
- get the client cache working along with sync and test it.


TODO: do it yourself. AppDbClient.





TODO: see if we can get Claude to massage this thing into a shape we can use. Otherwise, lets continue with TodoMVC.test.ts and createClient and go from there.

AppDbClient
- cache with data
- reference counts subscriptions to clocks
- applies optimistic writes and rebases

garbage collection process. cache subscribed ranges. LRU, wait some time before cleanup.

fetching wiht reference counting and cache invalidation after a timeout.


- rename
	appDb.getSyncDb(["todoList", listId])







whats the whole lifecycle on the client? lets make sure the code follows that clearly.
React hooks
Rebasing commits?




















---

Create branches to experiment with new layers and implementations...

- schema + ivm layer https://gemini.google.com/app/c7c41f3ae35e0b64

- syncable layer with version history and client side cache

- pubsub integrated thing.

- deferred eventually consistent job updates or whatever queue.

Gemini.md...
- tupledb
- syncdb
- recorddb
- use a separate types files

---

SyncDb server + pubsub backend plan


global syncDb: syncdb with "seen" for idempotency and no history, transactional pubsub as well
internal syncDb: have their own history, with potentially different operations.
clients write to the global syncDb operations, but sync down individul syncDb histories and apply those operations.


We need to slow down and actually do some designing... Lets focus on some specs and focus on how they work. That way we have a north star to build towards. Lets do this through a series of examples.

- Comms / Email Chat
- Chatrooms
- Social Feed

Take it slow!






Lets build some examples
1. a chat app, three types of records, user, profile, message. Each user gets a syncDb and writes fan out to all the relevant users. adding messages to inboxes or outboxes, editing user profiles, etc. This is the "full fanout" approach where clients only need to subscribe to a single syncdb clock.
2. the same chat app, but normalized a bit more. Users have an inbox syncdb, and outbox syncdb, and each individual profile is its own syncdb too. This way, the clients will have to subscribe to many syncDbs at once.

Contacts app example?




Lets build a simple but functional chat app as an example. three types of records, user, profile, message. We don't need to worry about permissions and validation for now, but in spirit, all the user's names are public via their profile. And then you can create messages to one or more person. This drops those messages into the users inbox/outbox kind of like email. For now, lets consider fanout on write so that messages are denormalized.








Sync cache frontend plan. Lets run through those examples.

Example 1: user subspace sync with full fanout

```
const ChatAppReducers = (authorId: string) => ({
	set(tx: TupleDb, args: {table: "user", id: string, value: User} | {table: "message", id: string, value: Message} | {table: "profile", id: string, value: Profile}) {
		if (args.table === "user") {
			tx.set(["users", user.id], user)
		}
		if (args.table === "message") {
			tx.set(["messages", msg.chatId, msg.createdAt, msg.id], msg)
		}
		// ...
	}
	delete(tx: TupleDb, args: {table: "user" | "message" | "profile", id: string}) {
		//...
	}
})
```

Example 2: chatroom subspace sync with partial fanout



const ChatAppReducers = {
	set(tx: TupleDb, args: {table: "user", id: string, value: User} | {table: "message", id: string, value: Message} | {table: "profile", id: string, value: Profile}) {
		if (args.table === "user") {
			tx.set(["users", user.id], user)
		}
		if (args.table === "message") {
			tx.set(["messages", msg.chatId, msg.createdAt, msg.id], msg)
		}
		// ...
	}
	delete(tx: TupleDb, args: {table: "user" | "message", id: string}) {
		//...
	}

}






You definitely need the fanout though. The clients don't have all the data, or permission.
* Fanning out a message to send is a perfect example. We need this top-level idea.
* Writing to two Notion blocks transactionally so that pointers line up is a different but relevant example.

on the backend...

function sendMessage() {
	for (person of msg.to)
		syncDb(tx.subspace(person)).addToInbox(msg)
}

each syncdb gets its own history there. but it isnt explicily pending...

on the frontend.

function sendMessage() {
	for (person of msg.to)
		tx.syncDb(person).addToInbox(msg)
}

This actually has the capability of tracking global transactions that are fanned out into local histories.

The tricky question though... whether global or local

https://chatgpt.com/c/695816b9-c750-8325-927e-e0e829507d38

Operations must be...


TODO: keep going here.
- simple solution -- all writes must be contained to the same syncdb. that's the simple and isolated approach
- how to extend that to work across multiple syncdbs?
	- fanout writes to different users.
	- transactionsally move pointers for two blocks
- how do we have to constrain write ops so that this is eventually consistent?
	- no read, only write
	- read must be guaranteed. read if exists and overwrite if exists. this doesnt work for creating new blocks though.
		- suppose I want to move a page from one place to another place. needs to be able to optimistically update
		- i need to be able to create a new record from scratch optimistically. x

Lets take a step back and think more pragmatically.
- the app has commit operations. its global

Two very different ways of doing things...
- a user gets a single syncdb in its entirety, writes fan out to each user, each user gets a single history. writing to their history triggers writes in other users on the backend. history for a single document requires indexing the history.
- a user gets a bunch of syncdb for different records. a contacts app feels more this way, where you sync with each individual peer to get their latest information. a more complex case is nested docs like Notion. Making a coordinated change between multiple documents at once.

the path forward...
- lets just start with one. a user gets an entire space and we fan out.
	example: todomvc
	multiple records.
- then lets have a few...
	example: chat app.
		user contacts / profiles
		chatrooms
- lets not worry about the coordinated write until we really need it... and honestly, we should probably just avoid it.



Version 1
- on the backend, each user gets a subspace syncdb.
- reducers for sending messages, etc.
- backend will fan out to each user subspace.
- clients sync that one user's subspace.
- inbox, outbox, to, from, reply.
- you can add properties and filters too if you want.

Version 2
- chatrooms, each room gets a subspace syncdb
- each user gets a profile syncdb
- clients with sync with each of the things they need
- creating a new chatroom will touch two syncdbs (1) the user channel list and (2) the new chatroom.
	- we need a path for the operations which identifies which syncdb. those operations all live together and commit transactionally.
	- as for the actual history, the histories don't actually know about each other. they're isolated.


brainstorm an example. methodically.











IClientSyncDb

data: ReadOnlyTupleDb & {
	subscribe: (args: ListArgs<Tuple>, listener: (result: { hit?: any[]; miss?: boolean; prefix?: any[] }) => void) => SubscribeResult
}




OkvCacheApi
TupleCacheApi


It seems like IClientSyncDb, this should be a type...




ClientSyncDb is {api, pubsub, cache} all in one. TupleCache doesnt handle fetching or reference reference counting and subscriptions.

Should we consolidate these abstractions a little bit though?



---


Lets extend the {pubsub, api} for replication as well.

```ts
const user = syncDb(db.subspace(["user", "user1"]))
const replica = syncDb(db2)
const userServer = syncServer(user) // api and pubsub
replicate(userServer, replica)
```



integration test
example test

SyncExample.test.ts
- read replica to another computer
- client cache partial read-write replica
- http and p2p transport option

- handling authorization / validation errors

- demo project. todomvc, messaging, history, offline, etc.




write my own test examples for syncDb and feel how it works.

create a sync-demo vite project.


can we piece all of this together somehow like this?
-> recordDb(syncDb(db.subspace(["user", id]), reducers).data)





SyncDb direction
- more general pattern of operations and sync.

list of operations, write them to the database, query them, get upates from syncdb.

















- later: more complicated queries returning larger sets of data that get denormalized on the client.
- todo, createdAt vs committedAt for recieving people, using server as the authority. how does this work for p2p?









---

ivm-plan-v2.md


TODO:
- Read the new RecordLayer. Read the tests. Expand tests probably. Make sure it works.
- SyncDb abstraction and frontend layer.

Lots more IVM ideas here: https://gemini.google.com/app/b77e912889adc0a8

from, map, filter, join, groupby, materialize union, flatten (tag list), difference (except),

RecordDb direction...
- based on v4, need to think more about syntax. Or generalization.
- later
	- conditional indexes?
	- js string reducer functions?








---

This looks good, but lets simplify things a bit and break it up into phases. To start, we can get rid of compound sort indexes. That's just complicated and we can still get what we want from that if we require the data to be denormalized into a consistent lexicographical order with what you want to query. So that's fine.

Phase 1: However, we still want to implement $gt, $gte, $le, and $lte. However since we don't have alternating indexes, we want to have some kind of query that is correct by construction. Something like {gte: {name: "A", date: "2020"}, lt: {name: "B"}} to specify ranges. And we need to think carefully about how these queries can be defines in a way that cannot construct an index and throw an error.

Phase 2: I like new way of defining joins with variables. That feels important and works well. To handle issues of disambiguating

Phase 3:




No mix sort.

Or and not, we can do in one step

gte, lte

array in

joins with variables

unique aggregation, but then also scanning that index.

---

Lets obsess over the dev experience. What apps should I build and go from there.
- journal log chat thing
- comms messaging app
- hey craft saas app

- media feed
- notion 3.0
- html editor
- p2p chat -> wiki -> airtable
- ai stack
- calendar





Let assume posts can have an array of tags. Users want to sort their timelines based on tags. And a post can be viewed in any of those timelines. The notification should only appear once.

---

Maybe subqueries should be `with` and not overloading `from`.



---

Plane work...

Lets think through things methodically. With examples.
- create schema
- create indexes
- run queries with auto-indexing

- reactivity (mostly for the client side)
- syncable buckets, server authority clock, optional history

later:
- run queries without auto-indexing
- use very simple histogram heuristics for query planning
- p2p syncable buckets

- how to index in batches with a cursor in a way thats also recoverable?
- how would we scale this system to something like postgres or foundationdb?

- How could we add the capability for conditional indexes?
- Run a query without creating an index by using selecting a suitable best index.
	- histogram trackign for query planning?

more thinking:
- can we break apart these different types of query systems and compose them?
- how can we implement interval trees in a way that composes?
	- how can we make compound interval trees?
	- is this just a generalization of aggregation queries?
- what are some more complicated queries that we cannot support?
	- **how can we index multiple types together. eliminate {where: {type}} from the query.**
	- what about querying with or vs and for multiple types.
	- triple join?
	- join with aggregation?
	- seems like we should maintain relationships between indexes when one relies on another like joins. deleting a join index could potentially propagate.
	- what is zql test suite contain in terms of queries.
- how can we LRU cache indexes or lazily update indexes.
- how can we lazily fan out writes?
	- basically every sync block can have its own clock relative to the authoratative write log. And it can query that log for relevant writes.

schema management...
- schema should be serializable, but perhaps migrations shouldn't be automatic.
- types are a coarse form a sharding.
- the main reason we can't do without types entirely is so we can define compound primary keys.
	- if we manually unroll primary keys and we have an id convention that can be compound, then we couuld drop the entire concept of types.
		- then we'd need indexes for where {type} from would be irrelevant, it wouuld be more like with...
- types reduce flexibility.
	- suppose you have notifications with join userId and postId. But then you want another kind of notification that's just a message from the admin. This just has a normal id. OK, it could totally just be another type, but then we'd want to merge our queries... And so long as that's possible, I think its fine. Because devs want schemas. Its makes it easier to think and reason about things.




```ts
const schema: Schema = {
	types: {
		user: { primary: ["id"] },
		post: { primary: ["id"] },
		follow: { primary: ["fromId", "toId"] },
		notification: { primary: ["userId", "postId"] },
	},
	indexes: {},
}


db.createType({user: ["id"]})
db.createType({post: ["id"]})
db.createType({follow: ["fromId", "toId"]})
db.createType({notification: ["userId", "postId"]})

// Manually create an index.
db.createIndex({from: "follow", sort: ["toId", "fromId"]}, /* optional name */)

// Looks like we can do a cleaner
const timeline = db.query({
	from: {
		a: {from: "follow"},
		b: {from: "post"}, // could even put a where clause in here...
	},
	where: {
		$user: "1",
		a: {toId: "$user"},
		b: {authorId: "$user"},
		b: {datetime: {$gte: "1234"}},
	},
	sort: [
		{b: "datetime"},
		{b: "id"}
	],
	reverse: true,
	limit: 10
})

// Variables for matching. It can all unfold into where.
const discover = db.query({
	from: {
		a: {from: "follow", where: {toId: "$a"}},
		b: {from: "follow", where: {fromId: "$a"}},
	},
	where: {
		a: {fromId: "1"},
	},
	sort: [
		{b: "toId"}
	],
})


// Use variables like f0 and f3 just for convenience.
const discover = db.query({
	from: {
		a: {from: "follow", where: {toId: "$f1", fromId: "$f0"}},
		b: {from: "follow", where: {fromId: "$f1", toId: "$f2"}},
		c: {from: "follow", where: {fromId: "$f2", toId: "$f3"}},
	},
	where: {
		$f0: "1"
	},
	sort: [
		"$f3"
	],
})


// Manual fanout for post notifications.
function createPost(db, post) {
	db.set(post)
	const follows = db.query({from: "follow", {where: {toId: post.authorId}}})
	for (const follow of follows) {
		db.set({type: "notification", postId: post.id, userId: follow.fromId, createdAt: post.id})
	}
}

// Tags, complex indexing.

```









































---


Is there any reason to have processAdHocJoin vs named joins? If its just about being terse, we could just query({from: schema.joins.namedJoin }) right?
I'm not seeing any tests that use just the joinName as the target. Seems like it could also conflict with record type names too.



It seems indexes and queries are redundant definitions... `indexes: { [name: string]: string[] }` is equivalent to just `{sort: string[]}` which is just a query.


export type AggregationSchema = {
	source: string
	groupBy: string[]
	kind: "count" | "sum" | "min" | "max"
	field?: string // Required for sum, min, max
}

query = {
	from: string,
	where: Record<string, any>,
	aggregate:
}



Certain things like the JoinSchema seem like they are much more verbose than they need to be and without any loss in generality we can specify it more like this:

const joinDef: JoinSchema = {
	left: {follow: "toId"}
	right: {follow: "fromId"}
	key: [
		{right: "toId"}, // User
		{left: "fromId"} // FoF
	],
}


---

Can you think of some examples of a three-way join? I'm imagining a discovery feed where you see posts not by people you follow but only my people who you follow follow. There might be a tricky piece here where we're excluding from the results. Not sure how to implement this.


---

How to handle indexing properties that should fanout like lists of tags, etc. And what about nested values, using dot-paths.

---


discovery feed: posts by follows of follows.


data type validation.

how does zql handle migrations / creating new record types or changing the schema.

how to LRU the indexes and purge them when they're unused for too long.

how does sql handle sync to the client?

can we run a query, gather all the objects necessary to create all the intermediate indexes, send it to the client, and let the client re-index and run that query... I suppose the one issue here might be permissions, if there are hidden record permissions that a user may not be privvy to that's used to generate the index. THat seems really rare though. Can you come up with a realistic example?



---

What's next... how do we do all this on the client? Maybe lets ask how zero does it.







what about aggregations across multiple tables... is there a use-case for that?
Define an arbitrary reducer for more aggregation options.
More aggregation types... sum, average, unique.


Join side with the optional index... lets dig into that. Why is that there? We should generate recursive indexes here, no?


Taking it a step further, maybe want a feed of posts from followers of followers and we want to add and remove from this list as follows are created or deleted. But we only care about recent posts (datetime in the last 24 hours). Maybe we have a background job to cleanup or something, but the point is that we don't need to backfill everything.



---

# Syncing...

contacts extreme case
