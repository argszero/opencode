export * as OpenCode from "./client.js"

import { SharedEvents } from "../shared-events.js"
import { OpenCode } from "./generated/index.js"
import type { ClientOptions } from "./generated/client.js"
import { makeRpc } from "./rpc.js"

export type { ClientOptions, RequestOptions } from "./generated/client.js"

export function make(options: ClientOptions) {
  const raw = OpenCode.make({ ...options, fetch: options.fetch ?? withoutDeadline })
  const events = SharedEvents.make((signal, onActivity) => raw.event.subscribe({ signal, onActivity }))
  return {
    ...raw,
    rpc: Object.assign(makeRpc(raw, events), raw.rpc),
    event: events,
  }
}

// Bun fails a request that stays idle for longer than five minutes. Long-pending requests are the
// norm for this API: a session command runs for as long as its executor does, `session.wait` blocks
// until the session settles, and the event stream is idle between events. Callers that want a
// bound pass an AbortSignal, so the default transport keeps no idle deadline of its own.
const withoutDeadline = Object.assign(
  (request: string | URL | Request, init?: BunFetchRequestInit) => fetch(request, { ...init, timeout: false }),
  { preconnect: () => undefined },
) satisfies typeof globalThis.fetch
