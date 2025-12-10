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

