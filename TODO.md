Create branches to experiment with new layers and implementations...

- schema + ivm layer https://gemini.google.com/app/c7c41f3ae35e0b64



- syncable layer with version history and client side cache

- pubsub integrated thing.

- deferred eventually consistent job updates or whatever queue.

---


lets prefer functional composition style rather than using a class for the record layer.

lets use similar verbs as we have for tupledb. set instead of put. list instead of scan, and it should take similar arguments.


Taking it a step further, maybe want a feed of posts from followers of followers and we want to add and remove from this list as follows are created or deleted. But we only care about recent posts (datetime in the last 24 hours). Maybe we have a background job to cleanup or something, but the point is that we don't need to backfill everything.
