import type { LLMRequest } from "../../schema/index.js"

/** Chat Completions rejects a `tool_call_id` longer than 40 characters. */
export const acceptsChatID = (id: string) => id.length <= 40

/**
 * The Responses `call_id` accepts more: recorded traffic through a Responses gateway carries
 * call IDs up to 43 characters, so the ceiling to stay under is 64 rather than 40.
 */
export const acceptsResponsesID = (id: string) => id.length <= 64

/** FNV-1a over two seeds. Nine base36 characters fit every charset these targets accept. */
export const hash = (value: string) => {
  const hash = (seed: number) => {
    let result = seed
    for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619)
    return (result >>> 0).toString(36)
  }
  return `${hash(2166136261).padStart(7, "0")}${hash(2246822519).padStart(7, "0")}`.slice(-9)
}

/**
 * Projects the request's tool call IDs onto a target that constrains them. An ID the target
 * already accepts is returned verbatim, so a provider that issues its own replayable IDs is
 * undisturbed; one it rejects is replaced by a hash of the source ID. The projection is
 * deterministic, so the same source ID always maps to the same target ID and call/result
 * pairing and prompt caching survive, and collision-safe, so a derived ID never repeats an ID
 * already present in the request nor another derived ID.
 */
export const normalizer = (request: LLMRequest, accepts: (id: string) => boolean) => {
  const ids = request.messages.flatMap((message) =>
    message.content.flatMap((part) => (part.type === "tool-call" || part.type === "tool-result" ? [part.id] : [])),
  )
  // Reserve accepted IDs before projecting any history, including IDs encountered later.
  const used = new Set(ids.filter(accepts))
  const normalized = new Map<string, string>()
  return (id: string) => {
    if (accepts(id)) return id
    const previous = normalized.get(id)
    if (previous !== undefined) return previous
    let attempt = 0
    let candidate = hash(id)
    while (!accepts(candidate) || used.has(candidate)) candidate = hash(`${id}:${++attempt}`)
    used.add(candidate)
    normalized.set(id, candidate)
    return candidate
  }
}

export * as ToolCallID from "./tool-call-id.js"
