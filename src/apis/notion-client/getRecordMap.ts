import { NotionAPI } from "notion-client"

export const getRecordMap = async (pageId: string) => {
  const api = new NotionAPI()
  const recordMap = await api.getPage(pageId, {
    gotOptions: {
      headers: {
        "user-agent": "notion-client (+https://github.com/NotionX/react-notion-x)",
      },
    },
  })
  return recordMap
}
