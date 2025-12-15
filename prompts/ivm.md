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
