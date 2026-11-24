import { idToUuid } from "notion-utils"
import { ExtendedRecordMap, ID } from "notion-types"

function getViewPageIds(view: any): ID[] {
  if (view?.collection_group_results?.blockIds) {
    return view.collection_group_results.blockIds
  }
  if (view?.blockIds) return view.blockIds

  // Grouped views return one results reducer per group instead of a single list.
  return Object.entries(view ?? {}).flatMap(([key, reducer]: [string, any]) =>
    key.startsWith("results:") ? reducer?.blockIds ?? [] : []
  )
}

export default function getAllPageIds(
  response: ExtendedRecordMap,
  viewId?: string
) {
  const collectionQuery = response.collection_query
  const views = Object.values(collectionQuery ?? {})[0] ?? {}

  let pageIds: ID[] = []
  if (viewId) {
    const vId = idToUuid(viewId)
    pageIds = [...new Set(getViewPageIds(views[vId]))]
  } else {
    const pageSet = new Set<ID>()
    // * type not exist
    Object.values(views).forEach((view: any) => {
      getViewPageIds(view).forEach((id: ID) => pageSet.add(id))
    })
    pageIds = [...pageSet]
  }
  return pageIds
}
