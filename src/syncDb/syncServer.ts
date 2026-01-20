import { tupleTx } from "tupleDb/TupleDb"
import { TupleDb } from "../tupleDb/types"
import { appDb } from "./appDb"
import { publish, PubsubServerApi } from "./pubsub"
import { CommitArgs, ReducerMap } from "./types"

export function syncServer(db: TupleDb, pubsub: PubsubServerApi, reducers: ReducerMap) {
	return {
		list: appDb(db, reducers).list,
		write(args: CommitArgs) {
			const tx = tupleTx(db)
			appDb(tx, reducers).write(args)
			tx.commit()

			publish(db, pubsub)
		},
	}
}
