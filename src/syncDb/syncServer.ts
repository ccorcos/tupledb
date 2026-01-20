import { TupleDb } from "../tupleDb/types"
import { appDb } from "./appDb"
import { publish, PubsubServerApi } from "./pubsubs"
import { CommitArgs, ReducerMap } from "./types"

export function syncServer(db: TupleDb, pubsub: PubsubServerApi, reducers: ReducerMap) {
	const app = appDb(db, reducers)
	return {
		list: app.list,
		write(args: CommitArgs) {
			app.write(args)
			publish(db, pubsub)
		},
	}
}
