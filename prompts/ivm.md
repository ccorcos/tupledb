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


