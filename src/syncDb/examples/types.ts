import { TupleDb } from "../../tupleDb/types"

// ============================================================================
// Domain Models
// ============================================================================

export type UserId = string
export type ChatId = string
export type MessageId = string

export type User = {
	id: UserId
	username: string
}

export type UserProfile = {
	id: UserId
	bio: string
	status: "online" | "offline"
}

export type Message = {
	id: MessageId
	chatId: ChatId
	fromId: UserId
	body: string
	createdAt: string
}

export type Chatroom = {
	id: ChatId
	name: string
	memberIds: UserId[]
}

// ============================================================================
// Example 1: Fan-out Reducers (Single User Subspace)
// ============================================================================

export type FanOutReducers = {
	putUser: (tx: TupleDb, user: User) => void
	putMessage: (tx: TupleDb, msg: Message) => void
	putProfile: (tx: TupleDb, profile: UserProfile) => void
}

// ============================================================================
// Example 2: Normalized Reducers (Multi-Subspace)
// ============================================================================

// 1. User DB: Manages the user's personal list of chats
export type UserReducers = {
	addChat: (tx: TupleDb, chat: Chatroom) => void
	removeChat: (tx: TupleDb, chatId: ChatId) => void
}

// 2. Chat DB: Manages messages within a chat
export type ChatReducers = {
	postMessage: (tx: TupleDb, msg: Message) => void
}

// 3. Profile DB: Global profile registry
export type ProfileReducers = {
	updateProfile: (tx: TupleDb, profile: UserProfile) => void
}

// Combined Reducers for the Client to use in "Global" write mode
// We need a way to route these to the right subspace, or we treat them as
// global operations that the server interprets.
// For Example 2, we'll assume the client uses a scoped-write approach,
// or a global reducer map that delegates.

export type GlobalAppReducers = {
	// Wrapper reducers that might take a scope or ID as first arg?
	// Or simply a union of all capabilities if the routing handles it.
	userOps: (tx: TupleDb, userId: UserId, op: { fn: keyof UserReducers; args: any[] }) => void
	chatOps: (tx: TupleDb, chatId: ChatId, op: { fn: keyof ChatReducers; args: any[] }) => void
	profileOps: (
		tx: TupleDb,
		userId: UserId,
		op: { fn: keyof ProfileReducers; args: any[] }
	) => void
}
