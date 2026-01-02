import {
	EncodeSubspaceListArgs,
	KeyDecodeCacheListResult,
	KeyEncodeList,
	KeyEncodeListArgs,
	KeyEncodeWrite,
	TupleSubspaceEncoder,
} from "./Encoder"
import { Range } from "./Range"
import {
	JSONValue,
	ListArgs,
	OkvCache,
	Tuple,
	TupleCache as TupleCacheApi,
	WriteArgs,
} from "./types"

export class TupleCache implements TupleCacheApi {
	constructor(
		public cache: OkvCache<Tuple, JSONValue>,
		public prefix: Tuple = []
	) {}

	subspace(prefix: Tuple) {
		return new TupleCache(this.cache, [...this.prefix, ...prefix])
	}

	compare = (a: Tuple, b: Tuple) => this.cache.compare(a, b)

	private get encoder() {
		return TupleSubspaceEncoder(this.prefix)
	}

	insert = (args: ListArgs<Tuple>, result: { key: Tuple; value: JSONValue }[]) => {
		const fullArgs = KeyEncodeListArgs(args, this.encoder)
		const fullResult = KeyEncodeList(result, this.encoder)
		this.cache.insert(fullArgs, fullResult)
	}

	list = (args: ListArgs<Tuple>) => {
		const fullArgs = EncodeSubspaceListArgs(args, this.prefix)
		const result = this.cache.list(fullArgs)
		return KeyDecodeCacheListResult(result, this.encoder)
	}

	listRaw = (args: ListArgs<Tuple>) => {
		const fullArgs = EncodeSubspaceListArgs(args, this.prefix)
		const result = this.cache.listRaw(fullArgs)
		return result.map(({ key, value }) => ({ key: this.encoder.decode(key), value }))
	}

	write = (args: WriteArgs<Tuple, JSONValue>) => {
		const fullArgs = KeyEncodeWrite(args, this.encoder)
		return this.cache.write(fullArgs)
	}

	subscribe = (range: Range<Tuple>, fn: () => void) => {
		const fullRange = KeyEncodeListArgs(range, this.encoder)
		return this.cache.subscribe(fullRange, fn)
	}

	apply = (changes: WriteArgs<Tuple, JSONValue>) => {
		const fullChanges = KeyEncodeWrite(changes, this.encoder)
		this.cache.apply(fullChanges)
	}
}
