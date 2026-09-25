import {
  DATATABLE_BLOCK_LANGUAGE,
  parseDatatableSource,
  serializeDatatableSpec,
  type DatatableSpec,
} from "@/lib/datatable"
import {
  MIND_MAP_FENCE_LANGUAGE,
  parseMindMapOutline,
  serializeMindMapOutline,
} from "@/lib/mind-map-outline"
import type { ShardMapFile } from "@/types"

/** 注册表里 parse 失败时的统一返回形状（技术方案 §4.4）。 */
export interface ShardBlockParseError {
  error: string
}

export type ShardBlockParseResult<Data> = Data | ShardBlockParseError

export function isShardBlockParseError<Data>(
  result: ShardBlockParseResult<Data>
): result is ShardBlockParseError {
  return typeof result === "object" && result !== null && "error" in result
}

/**
 * 围栏块的数据面（技术方案 §4.4）：lang / title / parse / serialize。
 *
 * 这一份必须保持纯数据——转换层与无 DOM 的 node 测试都 import 它，不能牵进
 * React、图标或 CSS。NodeView 组件、卡片预览、图标与 `/` 命令条目在
 * `registry-ui.tsx` 注册，两边按 lang 对齐。
 */
export interface ShardBlockDefinition<Data = unknown> {
  /** 围栏语言标识，全局唯一，小写。 */
  lang: string
  /** 命令菜单与占位显示名。 */
  title: string
  parse(source: string): ShardBlockParseResult<Data>
  /** 必须与 parse 往返一致。 */
  serialize(data: Data): string
}

const definitions = new Map<string, ShardBlockDefinition<never>>()

/** 围栏语言大小写与空白不敏感，与 `isMindMapFenceLanguage` 同一套归一化。 */
export function normalizeShardBlockLanguage(lang: string) {
  return lang.trim().toLowerCase()
}

export function registerShardBlock<Data>(definition: ShardBlockDefinition<Data>) {
  const lang = normalizeShardBlockLanguage(definition.lang)
  if (!lang) throw new Error("围栏块 lang 不能为空")
  definitions.set(lang, { ...definition, lang } as unknown as ShardBlockDefinition<never>)
}

export function unregisterShardBlock(lang: string) {
  definitions.delete(normalizeShardBlockLanguage(lang))
}

export function getShardBlock(lang: string): ShardBlockDefinition<never> | undefined {
  return definitions.get(normalizeShardBlockLanguage(lang))
}

export function isShardBlockLanguage(lang: string) {
  return definitions.has(normalizeShardBlockLanguage(lang))
}

export function listShardBlocks(): ShardBlockDefinition<never>[] {
  return Array.from(definitions.values())
}

/** 大纲块：解析与序列化全部复用 `mind-map-outline.ts`，不另起一套规则。 */
export const mindMapBlockDefinition: ShardBlockDefinition<ShardMapFile> = {
  lang: MIND_MAP_FENCE_LANGUAGE,
  title: "大纲",
  parse(source) {
    const { file } = parseMindMapOutline(source)
    return file ?? { error: "大纲为空" }
  },
  serialize(file) {
    return serializeMindMapOutline(file)
  },
}

/** 数据表：校验与规范化全部复用 `src/lib/datatable.ts`，组件与注册表同一份规则。 */
export const dataTableBlockDefinition: ShardBlockDefinition<DatatableSpec> = {
  lang: DATATABLE_BLOCK_LANGUAGE,
  title: "数据表",
  parse(source) {
    return parseDatatableSource(source)
  },
  serialize(spec) {
    return serializeDatatableSpec(spec)
  },
}

registerShardBlock(mindMapBlockDefinition)
registerShardBlock(dataTableBlockDefinition)
