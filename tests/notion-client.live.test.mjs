import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import ts from "typescript"

const require = createRequire(import.meta.url)

async function loadTypeScript(relativePath, dependency) {
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8")
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2020,
      target: ts.ScriptTarget.ES2020,
    },
  })
  const code = outputText.replace(
    `from "${dependency}"`,
    `from ${JSON.stringify(pathToFileURL(require.resolve(dependency)).href)}`
  )
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  )
}

const { notion } = await loadTypeScript(
  "../src/apis/notion-client/client.ts",
  "notion-client"
)
const { default: getAllPageIds } = await loadTypeScript(
  "../src/libs/utils/notion/getAllPageIds.ts",
  "notion-utils"
)

// Public fixtures from morethan-log and notion-client's own integration tests.
const fixtures = [
  ["blog template", "12c38b5f459d4eb9a759f92fba6cea36"],
  ["select boards", "a899b98b7cdc424585e5ddebbdae60cc"],
  [
    "table, list, gallery, calendar and multi-select groups",
    "2fea615a97a7401c81be486e4eec2e94",
  ],
]
if (process.env.NOTION_TEST_PAGE_ID) {
  fixtures.push(["configured blog database", process.env.NOTION_TEST_PAGE_ID])
}

for (const [name, pageId] of fixtures) {
  test(
    `live Notion queries: ${name}`,
    {
      skip: process.env.NOTION_LIVE_TEST !== "1",
      timeout: 120_000,
    },
    async () => {
      const raw = await notion.getPageRaw(pageId)
      const views = Object.values(raw.recordMap.collection_view ?? {}).map(
        (entry) => entry.value
      )
      assert.ok(views.length > 0, "Fixture must expose database views")

      for (const view of views) {
        const parent = raw.recordMap.block[view.parent_id]?.value
        const sibling = views.find(
          (other) =>
            other.parent_id === view.parent_id &&
            other.format?.collection_pointer
        )
        const collectionId =
          view.format?.collection_pointer?.id ??
          parent?.collection_id ??
          sibling?.format?.collection_pointer?.id
        assert.ok(collectionId, `Missing collection for ${view.id}`)
        // Call directly: getPage catches collection failures and could hide a broken query.
        const result = await notion.getCollectionData(
          collectionId,
          view.id,
          view
        )
        const reducers = result.result?.reducerResults
        assert.ok(
          reducers && Object.keys(reducers).length > 0,
          `No reducers for ${view.type}`
        )
        const grouped =
          view.format?.board_columns_by || view.format?.collection_group_by
        if (grouped) {
          const ids = getAllPageIds({
            collection_query: { [collectionId]: { [view.id]: reducers } },
          })
          assert.ok(
            ids.length > 0,
            `Grouped ${view.type} query returned no pages`
          )
        }
        assert.ok(JSON.stringify(result).length > 0)
      }
    }
  )
}
