import { NotionAPI } from "notion-client"

// Notion now wraps records as { spaceId, value: { value, role } }.
// Normalize before notion-client traverses blocks and fetches collections.
export function normalizeRecordMap(recordMap: Record<string, any>) {
  for (const table of Object.values(recordMap)) {
    if (!table || typeof table !== "object") continue

    for (const record of Object.values(table) as any[]) {
      if (
        record?.value &&
        typeof record.value === "object" &&
        "role" in record.value
      ) {
        const { role, value } = record.value
        record.role = role
        // Inaccessible records have a role but no value. Keep them JSON-safe.
        if (value === undefined) delete record.value
        else record.value = value
      }
    }
  }
}

function normalizeCollectionQuery(body: Record<string, any>) {
  if (!body.loader?.reducers) return body

  const reducers = Object.fromEntries(
    Object.entries(body.loader.reducers).map(
      ([key, reducer]: [string, any]) => {
        if (reducer.type !== "groups" || !reducer.groupBy?.property) {
          return [key, reducer]
        }

        return [
          key,
          {
            ...reducer,
            version: "v2",
            groupSortPreference: (reducer.groupSortPreference ?? []).map(
              (group: any) =>
                "property" in group
                  ? group
                  : {
                      property: reducer.groupBy.property,
                      value: group,
                    }
            ),
          },
        ]
      }
    )
  )

  return { ...body, loader: { ...body.loader, reducers } }
}

class CompatibleNotionAPI extends NotionAPI {
  async fetch<T>(options: Parameters<NotionAPI["fetch"]>[0]): Promise<T> {
    const response = await super.fetch<any>({
      ...options,
      body:
        options.endpoint === "queryCollection"
          ? normalizeCollectionQuery(options.body)
          : options.body,
      gotOptions: {
        ...options.gotOptions,
        headers: {
          ...options.gotOptions?.headers,
          "user-agent":
            "notion-client (+https://github.com/NotionX/react-notion-x)",
        },
      },
    })

    for (const map of [response?.recordMap, response?.recordMapWithRoles]) {
      if (map) normalizeRecordMap(map)
    }

    return response
  }
}

export const notion = new CompatibleNotionAPI()
