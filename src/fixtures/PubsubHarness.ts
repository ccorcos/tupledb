
// TODO Later:
// - connect, disconnect, reconnect.

import { PubsubClientApi, PubsubServerApi } from "syncDb/PubSub"

export class PubsubHarnessClient implements PubsubClientApi {
	constructor(private server: {
		subscribe: (key: string) => void
		unsubscribe: (key: string) => void
	}) { }


	subscribe(key: string): void {
		this.server.subscribe(key)
	}
	unsubscribe(key: string): void {
		this.server.unsubscribe(key)
	}

	listeners = new Set<(key: string, value: any) => void>()
	onMessage(listener: (key: string, value: any) => void): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	emit = (key: string, value: any): void => {
		for (const listener of this.listeners) {
			listener(key, value)
		}
	}
}

export class PubsubHarness implements PubsubServerApi {
	subscriptions = new Map<string, Set<(key: string, value: any) => void>>()
	publish(key: string, value: any): void {
		const listeners = this.subscriptions.get(key)
		if (!listeners) return
		for (const listener of listeners) listener(key, value)
	}

	clients = new Set<PubsubHarnessClient>()
	client() {
		const client = new PubsubHarnessClient({
			subscribe: (key: string) => {
				if (!this.subscriptions.has(key)) this.subscriptions.set(key, new Set())
				const listeners = this.subscriptions.get(key)
				listeners!.add(client.emit)
			},
			unsubscribe: (key: string) => {
				const listeners = this.subscriptions.get(key)
				listeners?.delete(client.emit)
			},
		})
		this.clients.add(client)
		return client
	}
}

