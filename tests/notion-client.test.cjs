const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { test } = require("node:test")
const vm = require("node:vm")
const ts = require("typescript")

// Load these TypeScript modules without introducing a test runner dependency.
function loadModule(relativePath, dependencies = {}) {
  const filename = path.join(__dirname, "..", relativePath)
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  })
  const exports = {}
  vm.runInNewContext(
    outputText,
    {
      exports,
      require: (name) => {
        if (!(name in dependencies))
          throw new Error(`Unexpected dependency: ${name}`)
        return dependencies[name]
      },
    },
    { filename }
  )
  return exports
}

class FakeNotionAPI {
  async fetch(options) {
    this.lastRequest = options
    return this.response
  }
}

const { notion, normalizeRecordMap } = loadModule(
  "src/apis/notion-client/client.ts",
  { "notion-client": { NotionAPI: FakeNotionAPI } }
)
const { default: getAllPageIds } = loadModule(
  "src/libs/utils/notion/getAllPageIds.ts",
  { "notion-utils": { idToUuid: (id) => id } }
)

test("normalizes records before the client reads blocks and collection views", async () => {
  const block = {
    id: "database",
    type: "collection_view_page",
    view_ids: ["view"],
  }
  const view = { id: "view", type: "table" }
  notion.response = {
    recordMap: {
      __version__: 3,
      block: {
        database: { spaceId: "space", value: { value: block, role: "reader" } },
      },
      collection_view: { view: { value: { value: view, role: "reader" } } },
      collection: {
        collection: { value: { value: { schema: {} }, role: "reader" } },
      },
    },
  }
  const result = await notion.fetch({ endpoint: "loadPageChunk", body: {} })
  assert.equal(result.recordMap.block.database.value, block)
  assert.equal(result.recordMap.collection_view.view.value, view)
  assert.equal(result.recordMap.block.database.role, "reader")
  assert.match(
    notion.lastRequest.gotOptions.headers["user-agent"],
    /notion-client/
  )
})

test("preserves legacy records and normalizes role-only records without undefined", () => {
  const legacy = { value: { id: "old", type: "page" }, role: "reader" }
  const map = {
    block: {
      old: legacy,
      private: { spaceId: "space", value: { role: "none" } },
    },
    collection: {},
  }
  normalizeRecordMap(map)
  normalizeRecordMap(map)
  assert.equal(map.block.old, legacy)
  assert.equal(map.block.old.value.id, "old")
  assert.equal(map.block.private.role, "none")
  assert.equal(Object.hasOwn(map.block.private, "value"), false)
  assert.deepEqual(JSON.parse(JSON.stringify(map)), map)
})

test("normalizes user record maps and preserves other request headers", async () => {
  notion.response = {
    recordMapWithRoles: {
      notion_user: {
        user: { value: { value: { id: "user" }, role: "reader" } },
      },
    },
  }
  const result = await notion.fetch({
    endpoint: "getRecordValues",
    body: {},
    gotOptions: { headers: { "x-test": "preserved" } },
  })
  assert.equal(result.recordMapWithRoles.notion_user.user.value.id, "user")
  assert.equal(notion.lastRequest.gotOptions.headers["x-test"], "preserved")
})

test("empty and missing collection queries produce no page IDs", () => {
  for (const response of [
    {},
    { collection_query: {} },
    { collection_query: { db: {} } },
  ]) {
    assert.equal(getAllPageIds(response).length, 0)
    assert.equal(getAllPageIds(response, "missing-view").length, 0)
  }
})

test("collects real page IDs, removes duplicates, and supports selected views", () => {
  const response = {
    collection_query: {
      db: {
        first: { collection_group_results: { blockIds: ["one", "two"] } },
        second: { collection_group_results: { blockIds: ["two", "three"] } },
      },
    },
  }
  assert.deepEqual(Array.from(getAllPageIds(response)), ["one", "two", "three"])
  assert.deepEqual(Array.from(getAllPageIds(response, "second")), [
    "two",
    "three",
  ])
})

for (const key of ["board_columns", "table_groups", "list_groups"]) {
  test(`${key} uses v2 group preferences while preserving filters and row reducers`, async () => {
    const body = {
      loader: {
        type: "reducer",
        filter: { operator: "and", filters: [] },
        reducers: {
          [key]: {
            type: "groups",
            groupBy: { type: "select", property: "status" },
            groupSortPreference: [
              { type: "select" },
              { type: "select", value: "Public" },
            ],
          },
          "results:select:Public": { type: "results", limit: 100 },
        },
      },
    }
    const original = JSON.stringify(body)
    notion.response = {}
    await notion.fetch({ endpoint: "queryCollection", body })
    const loader = notion.lastRequest.body.loader
    assert.equal(loader.reducers[key].version, "v2")
    assert.equal(loader.reducers[key].groupSortPreference[0].property, "status")
    assert.equal(
      loader.reducers[key].groupSortPreference[1].value.value,
      "Public"
    )
    assert.equal(
      loader.reducers["results:select:Public"],
      body.loader.reducers["results:select:Public"]
    )
    assert.equal(loader.filter, body.loader.filter)
    assert.equal(JSON.stringify(body), original)
  })
}

test("ungrouped queries and already normalized preferences remain valid", async () => {
  notion.response = {}
  const results = { type: "results", limit: 100 }
  const preference = {
    property: "status",
    value: { type: "select", value: "Public" },
  }
  await notion.fetch({
    endpoint: "queryCollection",
    body: {
      loader: {
        reducers: {
          collection_group_results: results,
          board_columns: {
            type: "groups",
            version: "v2",
            groupBy: { property: "status" },
            groupSortPreference: [preference],
          },
        },
      },
    },
  })
  assert.equal(
    notion.lastRequest.body.loader.reducers.collection_group_results,
    results
  )
  assert.equal(
    notion.lastRequest.body.loader.reducers.board_columns
      .groupSortPreference[0],
    preference
  )
})

test("grouped views yield actual page IDs instead of an empty blog", () => {
  const response = {
    collection_query: {
      db: {
        board: {
          board_columns: { type: "groups" },
          "results:select:Public": { blockIds: ["one", "two"] },
          "results:select:Other": { blockIds: ["two", "three"] },
        },
      },
    },
  }
  assert.deepEqual(Array.from(getAllPageIds(response)), ["one", "two", "three"])
  assert.deepEqual(Array.from(getAllPageIds(response, "board")), [
    "one",
    "two",
    "three",
  ])
})
