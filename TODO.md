Create branches to experiment with new layers and implementations...

- schema + ivm layer https://gemini.google.com/app/c7c41f3ae35e0b64



- syncable layer with version history and client side cache

- pubsub integrated thing.

- deferred eventually consistent job updates or whatever queue.


---





Get rid of `RecordListArgs` and just use `ListArgs<Tuple>`. I don't want prefix as an argument to list. That's what subspaces are for.


Join side with the optional index... lets dig into that. Why is that there? We should generate recursive indexes here, no?

Define an arbitrary reducer for more aggregation options.
More aggregation types... sum, average, unique.

Naming... records, aggregations, joins, indexes.




Taking it a step further, maybe want a feed of posts from followers of followers and we want to add and remove from this list as follows are created or deleted. But we only care about recent posts (datetime in the last 24 hours). Maybe we have a background job to cleanup or something, but the point is that we don't need to backfill everything.

