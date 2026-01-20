import React, { createContext, useContext, useRef, useEffect } from "react"
import { AppDbClient } from "../AppDbClient"
import { AppServerApi, PubsubApi } from "../types"
import { ReducerMap } from "../../types"

type AppDbContextValue<R extends ReducerMap = ReducerMap> = {
	appDb: AppDbClient<R>
	server: AppServerApi
	pubsub: PubsubApi
	authorId?: string
}

const AppDbContext = createContext<AppDbContextValue<any> | null>(null)

export type AppDbProviderProps<R extends ReducerMap = ReducerMap> = {
	server: AppServerApi
	pubsub: PubsubApi
	reducers: R
	authorId?: string
	children: React.ReactNode
}

export function AppDbProvider<R extends ReducerMap>({
	server,
	pubsub,
	reducers,
	authorId,
	children,
}: AppDbProviderProps<R>) {
	const appDbRef = useRef<AppDbClient<R> | null>(null)

	if (!appDbRef.current) {
		appDbRef.current = new AppDbClient({
			server,
			pubsub,
			reducers,
			authorId,
		})
	}

	useEffect(() => {
		return () => {
			appDbRef.current?.dispose()
		}
	}, [])

	const contextValue: AppDbContextValue<R> = {
		appDb: appDbRef.current,
		server,
		pubsub,
		authorId,
	}

	return <AppDbContext.Provider value={contextValue}>{children}</AppDbContext.Provider>
}

export function useAppDbContext<R extends ReducerMap = ReducerMap>(): AppDbContextValue<R> {
	const context = useContext(AppDbContext)
	if (!context) {
		throw new Error("useAppDbContext must be used within an AppDbProvider")
	}
	return context as AppDbContextValue<R>
}

export function useAppDb<R extends ReducerMap = ReducerMap>(): AppDbClient<R> {
	return useAppDbContext<R>().appDb
}
