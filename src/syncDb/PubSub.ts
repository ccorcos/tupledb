
export type PubsubClientApi = {
	subscribe(key: string): void
	unsubscribe(key: string): void
	onMessage(listener: (key: string, value: any) => void): () => void
}

export type PubsubServerApi = {
	publish(key: string, value: any): void
}
