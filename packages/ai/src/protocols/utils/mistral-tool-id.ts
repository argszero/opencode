import type { LLMRequest } from "../../schema/index.js"
import { ToolCallID } from "./tool-call-id.js"

export { hash } from "./tool-call-id.js"

export const valid = /^[A-Za-z0-9]{9}$/

export const normalizer = (request: LLMRequest) => ToolCallID.normalizer(request, (id) => valid.test(id))

export * as MistralToolID from "./mistral-tool-id.js"
