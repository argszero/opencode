export * as GlobTool from "./glob.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import path from "path"
import { toolFailure } from "../runtime.js"
import { ToolSearch } from "../search.js"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import { Environment } from "../../environment/index.js"
import { Flag } from "../../flag.js"
import { FileSystem } from "../../filesystem.js"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Ripgrep } from "../../ripgrep.js"
import { RelativePath } from "../../schema.js"
import { Permission } from "../../permission.js"

export const name = "glob"

export const Input = Schema.Struct({
  pattern: FileSystem.GlobInput.fields.pattern.annotate({ description: "Glob pattern to match files against" }),
  path: Schema.optionalKey(RelativePath).annotate({
    description: "Directory to search. Defaults to the current working directory.",
  }),
  hidden: FileSystem.GlobInput.fields.hidden.annotate({
    description: "Include hidden files and directories (default: false).",
  }),
  limit: FileSystem.GlobInput.fields.limit.annotate({
    description: `Maximum number of matching files to return (default: ${FileSystem.DEFAULT_SEARCH_LIMIT})`,
  }),
})

export const Output = Schema.Array(FileSystem.Entry)
type EncodedOutput = typeof Output.Encoded

/** Format raw search results into the concise line-oriented output models expect. */
export const toModelContent = (entries: EncodedOutput, truncated = false) => {
  const lines = entries.length === 0 ? ["No files found"] : entries.map((item) => item.path)
  if (truncated)
    lines.push(
      "",
      `(Results are truncated: showing first ${entries.length} results. Consider using a more specific path or pattern.)`,
    )
  return lines.join("\n")
}

/**
 * An absolute pattern names its own search root. ripgrep matches a glob against paths relative to the search root and
 * reads a leading `/` as an anchor to that root, so an absolute pattern can only ever match below a root that already
 * contains it: from `/workspace`, `--glob=/workspace/src/**` looks for `/workspace/workspace/src/**` and finds nothing.
 *
 * The deepest directory before the first glob metacharacter becomes the root and the rest stays anchored, so `/p/src/**`
 * searches `/p/src` for `/**` and `/p/*.md` searches `/p` for `/*.md`, which keeps its "direct children only" meaning.
 */
export function splitAbsolutePattern(pattern: string) {
  if (!path.isAbsolute(pattern)) return undefined
  // ripgrep reads `\` as a glob escape, so a Windows pattern is compared on the separator it accepts everywhere.
  const source = path.sep === "/" ? pattern : pattern.replaceAll("\\", "/")
  const head = source.slice(0, firstMetacharacter(source))
  const separator = head.lastIndexOf("/")
  // A pattern naming no directory (such as `/**`) is already anchored to the root it searches, so it has nothing to split.
  if (separator <= 0) return undefined
  return { path: source.slice(0, separator), pattern: source.slice(separator) }
}

/** Index of the first glob metacharacter that is not escaped, or the pattern's length when it holds none. */
function firstMetacharacter(pattern: string) {
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern.charAt(index)
    if (char === "\\") index++
    else if ("*?[{".includes(char)) return index
  }
  return pattern.length
}

/** Glob leaf that defaults its filesystem root to the active Location. */
export const Plugin = {
  id: "opencode.tool.glob",
  effect: Effect.fn("GlobTool.Plugin")(function* (ctx: Context) {
    const environment = yield* Environment.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service
    const config = yield* Config.Service
    // Internal plugins are not re-run on config changes, so reload the tool transform instead.
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.tool.reload())
    const flags = yield* Flag.Service

    yield* ctx.tool
      .transform((editor) => {
        if (flags.resolve(loaded.entries).full_codemode.enabled) return
        editor.add({
          name,
          options: { codemode: false },
          description:
            'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx"). An absolute pattern searches from its own directory.',
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const searchPath = input.path === "undefined" || input.path === "null" ? undefined : input.path
              const absolute = splitAbsolutePattern(input.pattern)
              const pattern = absolute?.pattern ?? input.pattern
              const root = absolute?.path ?? searchPath ?? "."
              const target = yield* access.resolve({ path: root, kind: "directory" })
              yield* access.authorizeExternal([target], context)
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root,
                  path: searchPath,
                  hidden: input.hidden,
                  limit: input.limit,
                },
                ...Permission.invocation(context),
              })
              const type = yield* ToolSearch.pathType(environment.files, target.absolute, root)
              if (type !== "directory")
                return yield* Effect.fail(new ToolFailure({ message: `Search path is not a directory: ${root}` }))
              const result = yield* ToolSearch.bounded(input.limit ?? FileSystem.DEFAULT_SEARCH_LIMIT, (limit) =>
                ripgrep.glob({ cwd: target.absolute, pattern, hidden: input.hidden, limit }),
              )
              return {
                entries: result.items.map((entry) =>
                  FileSystem.Entry.make({
                    ...entry,
                    path: RelativePath.make(
                      path.relative(location.directory, path.resolve(target.absolute, entry.path)),
                    ),
                  }),
                ),
                truncated: result.truncated,
              }
            }).pipe(
              Effect.map((result) => ({
                output: result.entries,
                content: toModelContent(
                  result.entries.map((entry) => ({ ...entry, path: path.resolve(location.directory, entry.path) })),
                  result.truncated,
                ),
                metadata: { count: result.entries.length, truncated: result.truncated },
              })),
              Effect.mapError((error) =>
                error instanceof Ripgrep.InvalidGlobError
                  ? new ToolFailure({ message: `Invalid glob in pattern ${error.message}` })
                  : toolFailure(`Unable to find files matching ${input.pattern}`)(error),
              ),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
}
