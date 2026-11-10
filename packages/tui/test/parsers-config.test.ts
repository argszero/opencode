import { describe, expect, test } from "bun:test"
import parsers from "../src/parsers-config"

// A grammar's queries have to be read at the version its parser is pinned to. A query that names a node the
// pinned parser does not have fails to compile, and the language silently renders as plain text (#62867, #46707).
const release = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\//
const queries = [
  /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/(.+)\/queries\//,
  /^https:\/\/github\.com\/([^/]+\/[^/]+)\/raw\/(.+)\/queries\//,
]

// Languages that still read a moving branch of their own grammar repository. Pinning them means checking that the
// query at the tagged version is still as complete as the one on the branch, which has not been done for them yet.
const branches = ["html", "php", "python"]

describe("parsers-config", () => {
  test("reads a grammar's queries at the version its parser is pinned to", () => {
    const drifted = parsers.parsers.flatMap((parser) => {
      const pinned = parser.wasm.match(release)
      if (!pinned) return []
      return Object.entries(parser.queries).flatMap(([kind, urls]) =>
        urls.flatMap((url) => {
          const fetched = queries.map((pattern) => url.match(pattern)).find(Boolean)
          if (!fetched || fetched[1] !== pinned[1]) return []
          const ref = fetched[2].replace(/^refs\/heads\//, "")
          // A commit sha is immutable, so it pins the query just as well as a tag does.
          if (ref === pinned[2] || /^[0-9a-f]{7,40}$/.test(ref)) return []
          return [parser.filetype]
        }),
      )
    })

    expect([...new Set(drifted)].sort()).toEqual(branches)
  })
})
