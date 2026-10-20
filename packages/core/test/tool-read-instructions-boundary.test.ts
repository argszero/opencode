import { afterAll, describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Location } from "@opencode/core/location"
import { Image } from "@opencode/core/image"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { AbsolutePath } from "@opencode/core/schema"
import { Global } from "@opencode/util/global"
import { FileAccess } from "@opencode/core/file-access"
import { location } from "./fixture/location"
import { Tool } from "@opencode/core/tool"
import { ReadTool } from "@opencode/core/tool/plugin/read"
import { ReadToolFileSystem } from "@opencode/core/tool/read-filesystem"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { SessionInstructions } from "@opencode/core/session/instructions"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin } from "./lib/tool"

// The session workspace is one project inside a larger repository, so the project root and
// the workspace differ. Discovery is expected to follow read targets anywhere in that
// repository and to skip targets outside it, as the Instructions docs describe.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-read-discovery-")))
const workspace = path.join(root, "proj-a")
const sibling = path.join(root, "proj-b")
const outside = path.join(root, "..", `${path.basename(root)}-outside`)

afterAll(() => {
  for (const dir of [root, outside]) fs.rmSync(dir, { recursive: true, force: true })
})

const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}
write(path.join(root, "AGENTS.md"), "repository-instructions")
write(path.join(workspace, "AGENTS.md"), "project-a-instructions")
write(path.join(sibling, "AGENTS.md"), "project-b-instructions")
write(path.join(sibling, "notes.txt"), "notes")
write(path.join(outside, "AGENTS.md"), "outside-instructions")
write(path.join(outside, "file.txt"), "outside")

const loaded: string[][] = []

const readToolNode = makeLocationNode({
  name: "test/read-tool-instructions-boundary",
  layer: Layer.effectDiscard(registerToolPlugin(ReadTool.Plugin)),
  deps: [
    Tool.node,
    ReadToolFileSystem.node,
    FileAccess.node,
    Image.node,
    Permission.node,
    SessionInstructions.node,
    FSUtil.node,
    Location.node,
  ],
})

// The reader is the only mocked filesystem boundary: discovery reads the real tree through
// FSUtil, and the paths handed to SessionInstructions are what this test asserts.
const reader = Layer.succeed(
  ReadToolFileSystem.Service,
  ReadToolFileSystem.Service.of({
    list: () => Effect.succeed([]),
    read: (input) =>
      Effect.succeed(
        input === AbsolutePath.make(sibling)
          ? new ReadToolFileSystem.ListPage({
              type: "list-page",
              entries: [{ path: AbsolutePath.make(path.join(sibling, "AGENTS.md")), type: "file" }],
              truncated: false,
            })
          : {
              type: "file",
              uri: `file://${input}`,
              name: path.basename(input),
              content: "read",
              encoding: "utf8",
              mime: "text/plain",
            },
      ),
  }),
)

const instructions = Layer.succeed(
  SessionInstructions.Service,
  SessionInstructions.Service.of({
    load: (input) => Effect.sync(() => void loaded.push([...input.paths])),
  }),
)

const imageLayer = Layer.mock(Image.Service, {
  normalize: () => Effect.fail(new Image.ResizerUnavailableError()),
})

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location({ directory: AbsolutePath.make(workspace) }, { projectDirectory: AbsolutePath.make(root) }),
  ),
)

const testLayer = Layer.mergeAll(
  AppNodeBuilder.build(LayerNode.group([Tool.node, readToolNode]), [
    ReadToolFileSystem.node.replace(reader),
    Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
    Config.node.replace(Config.testLayer()),
    Image.node.replace(imageLayer),
    SessionInstructions.node.replace(instructions),
    Location.node.replace(locationLayer),
    Global.node.replace(Global.layerWith({ data: Global.Path.data })),
  ]),
  Config.testLayer(),
  imageLayer,
)

const it = testEffect(testLayer)
const sessionID = Session.ID.make("ses_read_discovery_boundary")

const read = (input: string, id: string) =>
  Effect.gen(function* () {
    loaded.length = 0
    const registry = yield* Tool.Service
    const execution = yield* executeTool(registry, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id, name: "read", input: { path: input } },
    })
    expect(execution.status).toBe("completed")
    return loaded.flat()
  })

describe("read tool instruction discovery boundary", () => {
  it.effect("loads the instructions of a sibling project inside the same repository", () =>
    Effect.gen(function* () {
      expect(yield* read("../proj-b/notes.txt", "call-sibling-file")).toEqual([path.join(sibling, "AGENTS.md")])
    }),
  )

  it.effect("loads them for a directory listing as well", () =>
    Effect.gen(function* () {
      expect(yield* read("../proj-b", "call-sibling-list")).toEqual([path.join(sibling, "AGENTS.md")])
    }),
  )

  it.effect("does not reload the workspace instructions it walks past or the target itself", () =>
    Effect.gen(function* () {
      expect(yield* read("AGENTS.md", "call-workspace")).toEqual([])
      expect(yield* read(path.join(sibling, "AGENTS.md"), "call-sibling-instructions")).toEqual([])
    }),
  )

  it.effect("loads nothing for a target outside the repository", () =>
    Effect.gen(function* () {
      expect(yield* read(path.join(outside, "file.txt"), "call-outside")).toEqual([])
    }),
  )
})
