// 副作用导入：应用启动时让围栏块的 UI（NodeView 与卡片预览）完成注册。
import "./blocks/registry-ui"

export * from "./blocks/registry"
export * from "./blocks/registry-ui"
export * from "./markdown"
export { shardEditorExtensions, shardSchema } from "./schema"
