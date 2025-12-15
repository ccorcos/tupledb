From a coding style perspective, I prefer to use loops if you can do so without having to mutate a variable. For example:

This code

	// Check existing
	const existing = Object.entries(schema.records[type]).find(([name, fields]) => {
		if (name === "primary") return false
		return matchIndex(fields, whereKeys, sortKeys)
	})
	if (existing) return { schema, indexName: existing[0] }


Can be refactored into

	for (const [name, fields] in Object.entries(schema.records[type])) {
		if (name === "primary") continue
		const match = matchIndex(fiels, whereKeys, sortKeys)
		if (match) return match
	}

Lets do this kind refactor throughout

---

Remove all unused code. Simply abstraction to favor composition and remove layers of indirection. Lets use consistency of language to make things easier to reason about. For example, functiona like backfillX, backfillY, updateX, updateY make the code easy to understand and feel organized.

---

Use composition rather than optional arguments that can lead to runtime errors.

