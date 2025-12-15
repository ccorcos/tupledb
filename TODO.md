Create branches to experiment with new layers and implementations...

- schema + ivm layer https://gemini.google.com/app/c7c41f3ae35e0b64



- syncable layer with version history and client side cache

- pubsub integrated thing.

- deferred eventually consistent job updates or whatever queue.


---


s

I want a way to query based on best indexes and a way to query based on ensuring an index.

Are joins looking for existing index?

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
