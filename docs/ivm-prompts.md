I want to create a record layer with incremental view maintenance on top of tupledb.

We're going to use a follower-based social app as an example data model to test the various features.

```ts
type User = { type: "user", id: string; name: string; bio: string }
type Post = { type: "post", id: string; authorId: string; datetime: string; body: string }
type Follow = { type: "follow", fromId: string; toId: string; datetime: string }
```

All of the schemas should be specified in JSON so that they can be serialized and saves in the database. Then when the app boots up, the database can reload the schema to handle all of the indexing capabilities.

So here's what we're looking at.

We should have primary indexes for these objects. This needs to be specified somewhere.
```ts
["user", id]: User
["post", id]: Post
["follow", fromId, toId]: Follow
```

Note that the objects themselves all have a `type` property. I like this method where the object identifies itself entirely. That means we can just write objects to the database and the database knows how to identify them. We don't need to keep them separated by their type and identified elsewhere.

Then we need secondary indexes.
```ts
["user/name", user.name, user.id]: null
["post/author", post.authorId, post.datetime, post.id]: null // View a user's posts on their profile
["follow/to", follow.toId, follow.fromId]: null
```

Now is time to think about some more complicated indexes...

First, lets talk about the feed that each user sees. In practice, we don't actually want this to be an algebraic relationship because we don't want to backfill posts from the feed when a user creates a follow or delete posts when the unfollow. I think the best solution here is to manually fanout writes into another object which can then have its own secondary indexes.

```ts
type Notification = {
	userId: string
	postId: string
	postDatetime: string // <--- Denormalized sort key
	read: boolean
}

// primary key
["notification", userId, postId]: Notification

// feed
["notification/feed", userId, postDatetime, postId]: null
```

We still might want an algebraic representation for join indexes in other circumstances though. We'll keep going with this social app idea to help explain them.

One example is if we wanted to index a list of followers of followers.

Next, we might want an index for aggregations. For example a count of follows and followers. A count for the number of posts a user has. This aggregation concept should be easy to extend to things like sums and other kidns of math, etc.


Help me to implement this. Try to keep things simple and ergonomic.


---

Lets prefer functional composition style rather than using a class for the record layer. only use classes when encapsulating state.

```ts
const tdb = tupleDb()
const rdb = recordDb(tdb, schema)
```

Lets use similar verbs as we have for tupledb. Use set instead of put. And list instead of scan. And list args should be quite similar to tupleDb. The current scan args are just popping those first two args into the prefix. So really, its just subspace([type, index]).list(...).

---


Run typecheck. There are some errors. Also, this feels a bit too verbose sometimes. Functions like getPkPrefix and getIndexPrefix are just superfluous. extractKey seems ok though.

The scanIndex function still seems a bit overcommplicated. Its just db.subspace([type, index]).list({}) and then a function that takes the first and last value in that key to fetch the primary record.

Lets cleanup the code a little bit more. I like things to be clean and concise. A small amount of repetition can make things more legible sometimes especially if it makes the code substantially shorter.

Another thing thats missing is a `type RecordDb = {}`. Lets make sure to define that interface and be thoughtful about it.


---

I want to clean up the RecordDb abstraction a bit.
- Ordering of tuples can be error prone and also confusing in the code because items in the tuple aren't labeled either. So lets try to pass named args and use the schema to unroll them into the correct order when possible.
- I don't like `RecordListArgs` because I don't want prefix in there - that's what subspace is for. I actualy think we don't prefix or subspace though and ListArgs can take an object that gets unrolled into tupled before querying...

Something like this is what I'm looking for.

export type RecordDb = {
	// Args here contain primary key properties.
	get: (args: {type: string}) => {type: string} | undefined
	delete: (args: {type: string}) => void

	// These ares are the entire record.
	set: (record: {type: string}) => void

	// Use the schema to layout the keys appropriately
	aggregation: (name: string, args: {[key: string]: any}) => number

	// Scan the index and use the schema to unroll ListArgs into a tuple with the appropriate key ordering.
	index: (type: string, name: string, args: ListArgs<{[key: string]: any}>) =>

	// Do something similar here that makes sense for joins.
}


---

I want to think about improvements to @src/tupledb/RecordLayer.ts . What are some important missing features. What are some of the  ways we could improve the way we're specifying indexes, aggregations, and joins. I want you to do some research into an existing  implementation of IVM in mono/packages/zql/src/ivm and use that as inspiration for improving the record layer implementation. Note  that we don't want to use any of the zql code directly, but we do want to be inspired by their implementation details and ways we can improve our implementation. Please write you analysis in plans/zql.md for review.

---


Can we replace aggregation, index, and join methods with just a single `query` that will dynamically create the necessary indexes and maintain them? It seems like that's what zql is doing right?


---


In RecordLayer.test.ts we're still specifying indexes. Lets get rid of all those indexes and allow them to be generated. Lets make sure to assert not only that the query response is correct,  but that the index itself was generated.

We also need some way of specifying join queries so that those indexes can be automatically generated along with any necessary intermediate indexes. We should delete followersOfFollowers join in the schema definition and also assert that it gets generated upon querying.

---

CANCEL THIS - an index definition of {where: {a: null}} is gross

Lets consolidate index definition and query because they should be 1-to-1. Every query should be an perfect index scan. For joins where there need to be intermediate indexes, those indexes can also be defines as queries. I suppose there can be some ambiguity in how an index is laid out, but that can be solved by requiring index definitions to have explicit sort orders for all keys in the where clause.

Im thinking of a circumstance where we might want to filter {where: {a: 1, b: 2}} but also occasionally {where: {b: 12}} but never {where: {a: 13}}. In this case, it would be prudent to have a single index: [b, a] rather than two indexes [b] and [a,b]. However, if index definitions are just queries, then perhaps the index is generated by default sorted order of the key names [a,b], but since the underlying query itself doesnt have a sort, we can understand that this index can suffice in either order. This would allow us to run an index optimization fucntion that can look for these situations.

In terms of moving forward, I'd like to change our index definitions to just be queries with a deterministic default key order for any ambiguities in the query sort definition. And then we can write an entirely separate function `analyze` which will look at the queries and the indexes and see if there are any optimizations we can do, and then mayeb and `optimize(analysis)` function which will perform which ever specified optimizations we want.


---

Write a couple of different join queries:

- timeline feed is a list of time ordered posts by users that another user follows.
- the identity feed is similar to the timeline feed, but it's relative to the people who follow you. the idea being that this help the user understand who they're broadcasting to.


---


Regarding @src/tupledb/RecordLayer.ts, please refactor things to be cleaner and more concise. `processQuery` is a really long function that feels like it could be broken up. And it's not super clear the process of finding indexes, checking if they're a perfect match, if not a perfect match (only partial), then we'll want to generate and backfill the perfect index, and we should backfill by scanning over the best index we can find. Aggregations and joins feel like they're different enough that they should have their own factored out logic.


---

This looks good, but scanSmart still feels a little vague to me in terms of its functionality.

It seems we should have some helper functions specifically for finding indexes for queries. It can return whether there's a perfect match or a best match. Then from there we can either decide to scan the perfect index, or generate the perfect index using the best index and checkMatch.

findMatches shouldn't use scanSmart but actually just use processQuery. That would ensure that the intermediate indexes are created and maintained for the join query.

I think its important that we don't use checkMatch in order to avoid generating the perfect index for a user query.


---

IndexMatch could be a bit cleaner... Just {name: string, fields: string[]} | undefined. We can determine if its a full match based on fields.length.

---

Lets refactor RecordSchema to look more like {primary: string[], [index: string]: string[]}

---

Look at the refactoring we did since 0753212763404737aa348dccf4ea7a904870a8e6 commit. It looks good, but it seems like we can clean things up more though. Lets get rid of any unused code or abstractions. EnsurePerfectIndex has schemaChanged which doesnt appear to be used anywhere... The ViewStrategy seems like an unnecessary layer of abstraction and we should just focus on composition of functions. I like when the function names facilitate reading the code as if it were psuedocode written in plain english. And I like when there's consistency in naming... backfillRecordIndex, backfillAggregationIndex, backfillJoinIndex, etc.

Lets take a close eye to things like the scanAllRecords function. First off, I don't think its worth having this function. It's too small and we should just inline that wherever we need it. Secondly, when we're doing things like `.filter((v) => v !== null)`, clearly this is wrong! This means that there's stuff in those indexes that we don't want. This was added to pass a test without ever tracing the root cause of the issue which we recently fixed. So lets review the code to make sure that the underlying logic makes sense.


---

write a test where we query {sort: [b, a]} which will create an index. And then {where: {a, b}} should be able to reuse that index rather than create another index.

---

From a coding style perspective, I prefer to use loops if you can do so without having to mutate a variable. For example:

This code

	// Check existing
	const existing = Object.entries(schema.records[type]).find(([name, fields]) => {
		if (name === "primary") return false
		return matchIndex(fields, whereKeys, sortKeys)
	})
	if (existing) return { schema, indexName: existing[0] }


Can be refactored into

	for (const [name, fields] in Object.entries(schema.records[type])) {
		if (name === "primary") continue
		const match = matchIndex(fiels, whereKeys, sortKeys)
		if (match) return match
	}

Lets do this kind refactor throughout

---


Help me consider and plan for a big refactor. I'm not 100% sure it makes sense so I want you to figure out all the details and report back on whether its worthwhile.

It seems that indexes and queries are redundant concepts.
A record index is currently defined as `type: {name: string[]}` but it could just be `name: {from: type, sort: string[]}` which is a query.

I suspect aggregations and join have a similar relationships where we can get rid of the index schema and just use a query instead as the index definition.

Obviously, queries can be have ambiguities and using queries as index definitions definitely needs to be more restrained. For example, right now we don't have a concept of conditional indexes so the index definitions should not be allowed to have a where clause.

Something else to think about is that out schema itself can potentially be stored as more than one record in the schema subspace. One day, this could allow us to create indexes on our indexes for faster lookup of which indexes need updating and which indexes we can query. We don't need to do all of this right now, but I want to think about this as part of the planning the architecture of this database. At some point in the future, we could end up with many many indexes (queries) and so it would be nice if we don't have to check every one of them every time.

Help me think through this. List the costs and benefits. Consider various trade-offs. And plan out how this would be implemented. Write out your plan in plans/refactor.md




---

I'd like to see processQuery logic simplified a little bit.

Something more like:

function processQuery(db: TupleDb, schema: Schema, q: QueryQuery): { schema: Schema; result: any } {

	if (q.aggregate) {
		return processAggregationQuery(db, schema, q)
	}

	if (typeof q.from === "object") {
		return processJoinQuery(db, schema, q.from as JoinSchema, q)
	}

	return processRecordQuery(db, schema, target, q)
}

We can have a separate function called processIndexScan for querying over a named join, aggregation, or record index. But "contract" of the processQuery function is simple -- it will make sure there's an index and for that query as well as respond from that index.

---

I want to add the following functions to make this a little more usable for me.

isAmbiguousIndex(query) // Is this query an unambiguous query definition? Useful for developered debugging.
toUnambiguousIndex(query) // Will sort where keys and creates an unambiguous index definition that we'll use if we cant find a matching index.

ensureRecordIndex should be factored a bit more. It calls `hasIndex(query)` to check if it has an index. If not, it will call `createIndex(query)` (which calls `toUnambiguousIndex`). We should also have a function for `deleteIndex(query)`.

This should be consistent with aggregation and join indexes as well. I'm not sure the best way to do it. Perhaps the Query type should be a union type so we if its a RecordQuery | AggregationQuery | JoinQuery. That wouuld mean we could have things like hasAggregationQuery, deleteJoinIndex, etc.). Or maybe it we have that but it still makes sense to expose a unified interfac to the developer for `createIndex` as upposed to `createJoinIndex` and `createAggregationIndex`.


---



Code cleanup...

There's too much unnecessary recursion where the code recurses but passed down an entirely different branch. We should do this with recursion. What would you say to define this pattern more generally about how to code?
- createIndex -> createWhateverIndex
- backfillIndex -> backfillWhateverIndex and pass the def.

Example.

- createIndex(joinQuery)
	- ensureRecordIndex(recordQuery)
		- createIndex(recordQuery)
			- backfillIndex(recordQueryName)
			- saveIndex(recordQuery)
- backfillIndex(joinQueryName)
- saveIndex(joinQuery)

This should look more like. No recursion!

- createIndex(joinQuery)
	- createJoinIndex(joinQuery)
		- ensureRecordIndex(recordQuery)
			- createRecordIndex(recordQuery)
				- backfillRecordIndex(recordQuery)
				- saveRecordIndex(recordQuery)
- backfillJoinIndex(joinQuery)
- saveJoinIndex(joinQuery)

---


I want to think through some improvements to the way Query works in @src/tupledb/RecordLayer.ts


1. We need an ability to add comparisons.

I'm thinking maybe we can adopt a mongoose-style syntax but I'm flexible and willing to consider whatever argument structure is more rigorous.

```ts
db.query({
	from: "post",
	where: {
		author: "1234",
		datetime: {$gte: "5678"},
	},
	limit: 10,
	reverse: true,
})
```

I can imagine running into issues where the query demands compound indexes with alternating sort directions.

```ts
db.query({
	from: "x",
	where: {
		a: {$gte 1},
		b: {$lte: 2},
		c: {$gte: 3}
	}
})
```

We don't really a clean way of of doing that yet.  Perhaps `{sort: [{a: "asc"}, {b: "desc"}, {c: "asc"}]}`. But then in terms of the tupleDb and lexicodec, we'd need to investigate how to actually encode things or represent the in-memory comparison. This feels like a rabbithole. So lets investigate this and come up with some ideas.

2. We need an ability to do unions and probably differences and unique.

`db.query({from: "post", where: {tag: {$or: ["basketball", "soccer"]}}})`

Is this easy to implement? I can imagine wanting to place the $or a level higher too. Come up with some realistic examples to consider and how we might solve it.

3. Lets represent join queries as subqueries and introduce variables for matching.

The `from` clause can be for named subqueries which can be used in `where` and `sort` later.

So here are some ideas.

```ts
const fof = db.query({
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

// Another way.
const fof = db.query({
	from: {
		a: {from: "follow"},
		b: {from: "follow"},
	},
	where: {
		a: {toId: "$a"},
		b: {fromId: "$a"},
		a: {fromId: "1"},
	},
	sort: [
		{b: "toId"}
	],
})

// Another way with extra variables for easier comprehension.
const fof = db.query({
	from: {
		a: {from: "follow", where: {fromId: "$user", toId: "$a"}},
		b: {from: "follow", where: {fromId: "$a", toId: "$fof"}},
	},
	where: {
		$user: "1",
	},
	sort: [
		"$fof",
	],
})
```

Just to stress this abstraction a bit more, lets see how we can sort follows of follows based on the time in which the follow was made.

```ts
const fof = db.query({
	from: {
		a: {from: "follow", where: {fromId: "$user", toId: "$a", createdAt: "$t1"}},
		b: {from: "follow", where: {fromId: "$a", toId: "$fof", createdAt: "$t2"}},
	},
	where: {
		$user: "1",
	},
	sort: [
		"$t1",
		"$t2",
	],
	reverse: true
})
```

Now we have a list of follows of follows in order similar to that which the network evolved.

This new way of expression joins makes it possible to join n-ways too. For example, here's friends of friends of friends...

```ts
const fofof = db.query({
	from: {
		a: {from: "follow", where: {toId: "$f1", fromId: "$f0"}},
		b: {from: "follow", where: {fromId: "$f1", toId: "$f2"}},
		c: {from: "follow", where: {fromId: "$f2", toId: "$f3"}},
	},
	where: {
		$f0: "1"
	},
})
```

The the index will need to contain f0, f1, f2, and f3. What we likely care about is just the unique set of follows though.

```ts
const fofof = db.query({
	from: {
		a: {from: "follow", where: {toId: "$f1", fromId: "$f0"}},
		b: {from: "follow", where: {fromId: "$f1", toId: "$f2"}},
		c: {from: "follow", where: {fromId: "$f2", toId: "$f3"}},
	},
	where: {
		$f0: "1"
	},
	groupBy: ["$f1"],
	aggregate: {$f3: "unique"}
})
```

Now the question is how can we order this by createdAt time while still being unique and taking the earlier value. We might arbitrarily decide to take the latest value too -- I'm not sure the best way to represent this.

In general, we need to support `unique` which I would assume is an aggregation. And we should probably support aggregations on join queries as well.


Help me think through these ideas. In particular, explore what kinds of features we do not support that devs will likely need to build complex applications. Propose solutions. Think carefully about the syntax of the Query type as well. We want things to be general. One thing I don't love about variable syntax being just a string starting with $ is that it means you can't have values that start with $ and that's not great either.

Write a plan into docs/query.md

---


We need to think of a list of queries for dogfooding.

Note that `query()` will return a list of tuple keys and values (reference counts or aggregation results).
You can then call `get()` to actually get the objects you might want based on the results.


1. Lookup a user by name.

```ts
match: {u: {from: "user"}},
index: ["u.name", "u.id"],
scan: {prefix: ["Chet"]}
```

2. Lookup a user sorted by age with paging.

```ts
match: {u: {from: "user"}},
index: ["u.age", "u.id"],
scan: {gte: [18], limit: 20}
```

3. Lookup a user by name and bio.

```ts
match: {u: {from: "user"}},
index: ["u.bio", "u.name", "u.id"],
```

4. Count unique user bios for given name.

```ts
match: {u: {from: "user"}},
groupBy: ["u.bio"]
reduce: {byName: {count: "u.name"} }
```

4. All users ordered by latest post.
```ts
match: {p: {from: "post"}},
groupBy: ["p.authorId"],
reduce: {latestPostAt: {max: "p.createdAt"}},
index: ["latestPostAt", "p.authorId"],
```

- **Question:** What is groupBy really doing here? And then it shows up in index again. That's weird...

5. Follower feed.
```ts
match: {
	f: {from: "follow"},
	p: {from: "post", where: {authorId: "f.toId"}},
},
index: ["f.fromId", "p.createdAt", "p.id"],
```

- **NOTE:** Are aren't using $ for variables. We need some way of disambiguating variables and ordinary value matches though.

6. Follow of follow list ordered by when they entered your orbit.

```ts
match: {
	f: {from: "follow"},
	f2: {from: "follow", where: {fromId: "f.toId"}},
},
groupBy: ["f.fromId", "f2.toId"],
reduce: {order: {min: {max: ["f2.createdAt", "f.createdAt"]}}}
index: ["f.fromId", "order", "f2.toId"],
scan: {prefix: ["myUserId"], limit: 10},
```

7. Friends of friends feed.
```ts
match: {
	f: {from: "follow"},
	f2: {from: "follow", where: {fromId: "f.toId"}},
	p: {from: "post", where: {authorId: "f2.toId"}},
},
index: ["f.fromId", "p.createdAt", "p.id"],
```

- **NOTE:** These posts are inherently unique based on the the index key.

---

Not sure where I used this but I did



record query:
{from: "type", where: {a: 1, b: 2}, sort: ["c", "d"], gt: [1,2], lte: [3]}

join index:
{
	bind: {a: "value"},
	match: {
		a: {from: "type", where: {a: "a", b: "var"}},
		b: {from: "type", where: {a: "a", b: "var"}},
	},
	index: ["a.id", "b.id"]
}

aggregation index:
{
	[from or match]
	groupBy: ["a", "b"],
	reduce: {
		aggregationName: {sum: "a.property"}
	}
	index: ["aggregationName", "a","b"]
}

---

