/** 编辑面的保存态：资料库头部、底部状态栏与禅模式操作条共用同一套文案。 */
export type SaveState = "dirty" | "error" | "saved" | "saving"

export function formatSaveState(state: SaveState) {
  switch (state) {
    case "dirty":
      return "待保存"
    case "error":
      return "保存失败"
    case "saving":
      return "保存中…"
    case "saved":
    default:
      return "已保存"
  }
}
