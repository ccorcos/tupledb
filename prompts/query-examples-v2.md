

1. Lookup a user by name.

```ts
match: {u: {from: "user"}},
index: ["u.name", "u.id"],
scan: {prefix: ["Chet"]}
```

2. Lookup a user sorted by age with paging.

```ts
match: {u: {from: "user"}},
index: ["u.age", "u.id"],
scan: {gte: [18], limit: 20}
```

3. Lookup a user by name and bio.

```ts
match: {u: {from: "user"}},
index: ["u.bio", "u.name", "u.id"],
```

4. Count unique user bios for given name.

```ts
match: {u: {from: "user"}},
groupBy: ["u.bio"]
reduce: {byName: {count: "u.name"} }
```

4. All users ordered by latest post.
```ts
match: {p: {from: "post"}},
groupBy: ["p.authorId"],
reduce: {latestPostAt: {max: "p.createdAt"}},
index: ["latestPostAt", "p.authorId"],
```

5. Follower feed.
```ts
match: {
	f: {from: "follow"},
	p: {from: "post", where: {authorId: "f.toId"}},
},
index: ["f.fromId", "p.createdAt", "p.id"],
```

6. Follow of follow list ordered by when they entered your orbit.

```ts
match: {
	f: {from: "follow"},
	f2: {from: "follow", where: {fromId: "f.toId"}},
},
groupBy: ["f.fromId", "f2.toId"],
reduce: {order: {min: {max: ["f2.createdAt", "f.createdAt"]}}}
index: ["f.fromId", "order", "f2.toId"],
scan: {prefix: ["myUserId"], limit: 10},
```

7. Friends of friends feed.
```ts
match: {
	f: {from: "follow"},
	f2: {from: "follow", where: {fromId: "f.toId"}},
	p: {from: "post", where: {authorId: "f2.toId"}},
},
index: ["f.fromId", "p.createdAt", "p.id"],
```
