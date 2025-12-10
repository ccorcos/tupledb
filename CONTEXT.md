(Flattened context for dropping this straight into an AI chat prompt.)

I've created a simple foundationdb-inspired database in TypeScript. It leans heavily on functional composition.

```ts
type Range<K> = { gt?: K; gte?: K; lt?: K; lte?: K }

type Tuple = any[]

type JSONValue = any

type WriteArgs<K, V> = { set?: { key: K; value: V }[]; delete?: K[] }

type ListOptions = {
	limit?: number
	// offset?: number
	reverse?: boolean
}

type ListArgs<K> = Range<K> & ListOptions

/**
 * Compare is important so that we can do other in-memory things, e.g. caching reads
 * and writes in a transaction. Otherwise it's just read and write.
 */
type Okv<K, V> = {
	compare: (a: K, b: K) => number
	list(args?: ListArgs<K>): { key: K; value: V }[]
	write: (tx: WriteArgs<K, V>) => void
}

type OkvTx<K, V> = Okv<K, V> & {
	committed: boolean
	commit: () => void
}

type TupleOkv = Okv<Tuple, JSONValue>
type TupleOkvTx = OkvTx<Tuple, JSONValue>

type TupleDb = TupleOkv & {
	get: (key: Tuple) => JSONValue | undefined
	has: (key: Tuple) => boolean
	set: (key: Tuple, value: JSONValue) => void
	delete: (key: Tuple) => void
	subspace: (prefix: Tuple) => TupleDb
}

type TupleTx = TupleOkvTx & {
	get: (key: Tuple) => JSONValue | undefined
	has: (key: Tuple) => boolean
	set: (key: Tuple, value: JSONValue) => void
	delete: (key: Tuple) => void
	// Reverts back to TupleDb to avoid committing with the subspace.
	subspace: (prefix: Tuple) => TupleDb
}
```

Here's a little peak into how it's implemented under the hood. The codec is used for comparing tuples and can also encode them into lexicographical strings for storing in SQLite as a backend.

```ts
type KeyEncoder<I, O> = {
	compare: (a: I, b: I) => number
	encode: (key: I) => O
	decode: (key: O) => I
}

type Encoder<I, O> = {
	encode: (key: I) => O
	decode: (key: O) => I
}

function KeyEncodeOKV<I, O, V>(db: Okv<O, V>, encoder: KeyEncoder<I, O>): Okv<I, V> {
	return {
		compare: encoder.compare,
		list(args) {
			const newArgs = KeyEncodeListArgs(args || {}, encoder)
			const results = db.list(newArgs)
			return KeyDecodeList(results, encoder)
		},
		write(args) {
			const newArgs = KeyEncodeWrite(args, encoder)
			return db.write(newArgs)
		},
	}
}

function ValueEncodeOKV<K, I, O>(db: Okv<K, O>, encoder: Encoder<I, O>): Okv<K, I> {
	return {
		compare: db.compare,
		list(args) {
			return db.list(args).map(({ key, value }) => ({ key, value: encoder.decode(value) }))
		},
		write(tx: { set?: { key: K; value: I }[]; delete?: K[] }) {
			return db.write({
				set: tx.set?.map(({ key, value }) => ({ key, value: encoder.encode(value) })),
				delete: tx.delete,
			})
		},
	}
}

// OKV -> TupleOKV -> TupleDb -> TupleTx

function tupleOkv(okv?: Okv<string, string>): TupleOkv {
	if (!okv) okv = new InMemoryOkv(codec.compare)
	return ValueEncodeOKV(KeyEncodeOKV(okv, codec), {
		encode: (value) => JSON.stringify(value),
		decode: (value) => JSON.parse(value),
	})
}

function subspace(db: TupleOkv, prefix: Tuple): TupleOkv {
	const encoder = TupleSubspaceEncoder(prefix)
	return {
		compare: db.compare,
		list: (args = {}) => {
			const result = db.list(EncodeSubspaceListArgs(args, prefix))
			return KeyDecodeList(result, encoder)
		},
		write: (args) => {
			return db.write(KeyEncodeWrite(args, encoder))
		},
	}
}

/**
 * Separating the sugar from the base api makes it a lot easier to build compositional
 * abstractions because the base layer is the only two functions we need to wrap.
 */
function tupleDb(db?: TupleOkv): TupleDb {
	if (!db) db = tupleOkv()
	const { compare, list, write } = db
	return {
		compare,
		list,
		write,
		get: (key) => db.list({ gte: key, lte: key }).at(0)?.value,
		has: (key) => db.list({ gte: key, lte: key }).length > 0,
		set: (key, value) => db.write({ set: [{ key, value }] }),
		delete: (key) => db.write({ delete: [key] }),
		subspace: (prefix) => tupleDb(subspace(db, prefix)),
	}
}

function tupleTx(db: TupleOkv): TupleTx {
	const baseTx = new Transaction(db)
	const sugar = tupleDb(baseTx)
	return {
		...sugar,
		compare: baseTx.compare,
		list: baseTx.list,
		write: baseTx.write,
		commit: baseTx.commit,
		get committed() {
			return baseTx.committed
		},
	}
}

class Transaction<K, V> implements OkvTx<K, V> {
	committed = false

	pending: {
		set: InMemoryOkv<K, V>
		delete: InMemoryOkv<K, null>
	}

	constructor(public db: Okv<K, V>) {
		this.pending = {
			set: new InMemoryOkv(this.db.compare),
			delete: new InMemoryOkv(this.db.compare),
		}
	}

	get compare() {
		return this.db.compare
	}

	/**
	 * This version will overfetch as needed to satisfy the limit in a single request.
	 * An alternative approach would not overfetch but will need to make multiple requests.
	 */
	list = (args: ListArgs<K> = {}): { key: K; value: V }[] => {
		if (this.committed) throw new Error("Transaction already committed")

		const range: Range<K> = {
			gt: args.gt,
			gte: args.gte,
			lt: args.lt,
			lte: args.lte,
		}

		const fetchArgs = { ...args }
		if (fetchArgs.limit !== undefined) {
			// If fetching range [A,B] with limit N, then all the delete could be at the beginning
			// of that range and all the sets could be at the end of the range, after the limit.
			// Thus in the worst case, we need to overfetch the number of deletes in that range.
			const deletes = this.pending.delete.list(range)
			fetchArgs.limit += deletes.length
		}

		// First read the data from the database.
		const data = this.db.list(fetchArgs)

		// Overwrite with pending data.
		const slice = new InMemoryOkv<K, V>(this.db.compare)
		slice.write({ set: data })
		slice.write({
			// Only select from the range we actually need.
			set: this.pending.set.list(range),
			delete: this.pending.delete.list(range).map(({ key }) => key),
		})

		// Select what we need from the slice.
		return slice.list(args)
	}

	write = (args: WriteArgs<K, V>) => {
		if (this.committed) throw new Error("Transaction already committed")
		this.pending.set.write({ set: args.set, delete: args.delete })
		this.pending.delete.write({
			set: args.delete?.map((key) => ({ key, value: null })),
			delete: args.set?.map(({ key }) => key) ?? [],
		})
	}

	commit = () => {
		if (this.committed) throw new Error("Transaction already committed")
		this.committed = true
		this.db.write({
			set: this.pending.set.list(),
			delete: this.pending.delete.list().map(({ key }) => key),
		})
	}
}
```

While we can do `tupleOkv(new InMemoryOkv())`, we'd be serializing keys when we don't have to so its much more performant just to pass a custom compare function and it we end up with the same thing `new InMemoryOkv(codec.compare)`.

In terms of using this, you just need to create the base okv.

```ts
// For a persisted database
const base = tupleOkv(new SqliteOkv("app.db"))
// For an in-memory database
const base = new InMemoryOkv(codec.compare)
```

And then the tuple layer is all just syntax sugar on top.

```ts
const db = tupleDb(base)

db.set(["users", 1], { id: 1, name: "Chet" })
db.has(["users", 1])
db.get(["users", 1])
db.delete(["users", 1])

const users = db.subspace(["users"])
users.set(2, { id: 2, name: "Simon" })
```

Functions compose really well for writing to the database. You have full flexibility to update indexes and fan out however you want.

```ts
function fanoutSendMessage(tx: TupleDb, msg: Message) {
	for (const to of msg) tx.set(["inbox", to, msg.timestamp, msg.id], null)
}

function sendMessage(tx: TupleDb, msg: Message) {
	tx.set(["message", msg.id], msg)
	fanoutSendMessage(msg)
	// More firebase-inspired way to index messages nested inside the user.
	tx.subspace(["user", msg.from]).set(["sent", msg.timestamp, msg.id], msg)
}

const tx = tupleTx()
sendMessage(tx, msg)
tx.commit()
```
