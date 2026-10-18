import { expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { Shell } from "@opencode/core/shell"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"
import { it } from "./lib/effect"

const layer = AppNodeBuilder.build(Shell.node, [
  Location.node.replace(tempLocationLayer),
  Global.node.replace(tempGlobalLayer),
  Config.node.replace(Config.testLayer()),
  Environment.node.replace(hostEnvironmentLayer),
])

/** Runs a command to completion, so its capture is in place before the pages are read. */
const capture = (command: string) =>
  Effect.gen(function* () {
    const shell = yield* Shell.Service
    const started = yield* shell.create({ shell: "/bin/sh", command, timeout: 0 })
    yield* shell.wait(started.id)
    return { shell, id: started.id }
  })

it.live("reads a page from a capture", () =>
  Effect.gen(function* () {
    const { shell, id } = yield* capture("printf fixture-output")
    expect(yield* shell.output(id, { cursor: 0, limit: 7 })).toMatchObject({ output: "fixture", cursor: 7 })
  }).pipe(Effect.provide(layer)),
)

it.live("an explicit zero limit reads an empty page instead of failing", () =>
  Effect.gen(function* () {
    const { shell, id } = yield* capture("printf fixture-output")

    // The schema accepts `limit: 0`, so the page it describes has to exist: zero bytes read, and a
    // cursor the caller can carry on from. Building the file range instead ended at -1, and
    // `createReadStream` threw a RangeError for a request the public contract allowed.
    const page = yield* shell.output(id, { cursor: 0, limit: 0 })

    expect(page).toMatchObject({ output: "", cursor: 0 })
    expect(page.size).toBeGreaterThan(0)
  }).pipe(Effect.provide(layer)),
)

it.live("a zero limit in the middle of a capture keeps the cursor where the caller asked", () =>
  Effect.gen(function* () {
    const { shell, id } = yield* capture("printf fixture-output")
    const first = yield* shell.output(id, { cursor: 0, limit: 3 })

    expect(yield* shell.output(id, { cursor: first.cursor, limit: 0 })).toMatchObject({
      output: "",
      cursor: first.cursor,
    })
    // The page after the empty one is exactly the bytes the zero-limit page did not consume.
    expect(yield* shell.output(id, { cursor: first.cursor, limit: 7 })).toMatchObject({ output: "ture-ou" })
  }).pipe(Effect.provide(layer)),
)
