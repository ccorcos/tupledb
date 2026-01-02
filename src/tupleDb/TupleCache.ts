import {
	EncodeSubspaceListArgs,
	KeyDecodeCacheListResult,
	KeyEncodeList,
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

	insert = (items: { args: ListArgs<Tuple>; result: { key: Tuple; value: JSONValue }[] }[]) => {
		const fullItems = items.map(({ args, result }) => ({
			args: EncodeSubspaceListArgs(args, this.prefix),
			result: KeyEncodeList(result, this.encoder),
		}))
		this.cache.insert(fullItems)
	}

	list = (args: ListArgs<Tuple>) => {
		const fullArgs = EncodeSubspaceListArgs(args, this.prefix)
		const result = this.cache.list(fullArgs)
		return KeyDecodeCacheListResult(result, this.encoder)
	}

	write = (args: WriteArgs<Tuple, JSONValue>) => {
		const fullArgs = KeyEncodeWrite(args, this.encoder)
		return this.cache.write(fullArgs)
	}

	subscribe = (range: Range<Tuple>, fn: () => void) => {
		const fullRange = EncodeSubspaceListArgs(range, this.prefix)
		return this.cache.subscribe(fullRange, fn)
	}
}
