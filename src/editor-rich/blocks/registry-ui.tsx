import type { ComponentType } from "react"

import { GitBranchIcon, TableIcon, type ShardIcon } from "@/components/icons"
import { DatatableBlock } from "@/components/shard/datatable/datatable-block"
import { MindMapFenceEmbed } from "@/components/shard/mind-map-fence-embed"
import { MindMapFenceWidget } from "@/components/shard/mind-map-fence-widget"
import {
  EMPTY_MIND_MAP_OUTLINE_SOURCE,
  MIND_MAP_FENCE_LANGUAGE,
} from "@/lib/mind-map-outline"
import { createDatatableTemplate, DATATABLE_BLOCK_LANGUAGE } from "@/lib/datatable"

import { normalizeShardBlockLanguage } from "./registry"

/**
 * 围栏块的 UI 面（技术方案 §4.4）。
 *
 * 与 `registry.ts` 分家的理由：那一份是纯数据（lang/title/parse/serialize），
 * 要能在无 DOM 的 node 测试里 import；这一份带 React 组件、图标与 CSS，
 * 只在真正渲染的地方引。编辑器 NodeView、碎片卡片与 `/` 命令菜单都查这里，
 * 因此新增一个围栏块只需要在本文件注册一次，编辑器、转换层与卡片渲染不用改。
 */

export interface ShardBlockEditorProps {
  /** 围栏正文（不含 ``` 标记行）。 */
  source: string
  readOnly: boolean
  onChange: (source: string) => void
  /** 把焦点交回外层编辑器，并把选区放到该块之后。 */
  onExit: () => void
  /** 宿主编辑器 id，组件需要区分多实例时用。 */
  editorId: string
}

export interface ShardBlockPreviewProps {
  source: string
}

export interface ShardBlockSlashItem {
  /**
   * 命令 id。与 `src/lib/slash-commands.ts` 的 `SlashCommandId` 同名时，
   * 菜单以块注册表这一条为准，不会出现两条重复的候选。
   */
  id: string
  label: string
  /** 候选右侧的徽标，与 `SlashCommand.hint` 同一列。 */
  hint: string
  keywords: readonly string[]
  /** 插入时写进围栏的正文。 */
  template: string
  /**
   * 插入后要聚焦的 NodeView 内元素选择器。不填则焦点留在块之后，
   * 编辑器不需要为某个块写专门的聚焦分支。
   */
  focusSelector?: string
}

export interface ShardBlockUI {
  /** 编辑态 NodeView 的内容组件。 */
  Editor: ComponentType<ShardBlockEditorProps>
  /** 碎片卡片的只读渲染。 */
  Preview: ComponentType<ShardBlockPreviewProps>
  icon?: ShardIcon
  slash?: ShardBlockSlashItem
}

const registry = new Map<string, ShardBlockUI>()

export function registerBlockUI(lang: string, ui: ShardBlockUI) {
  const normalized = normalizeShardBlockLanguage(lang)
  if (!normalized) throw new Error("围栏块 lang 不能为空")
  registry.set(normalized, ui)
}

export function unregisterBlockUI(lang: string) {
  registry.delete(normalizeShardBlockLanguage(lang))
}

export function getBlockUI(lang: string): ShardBlockUI | undefined {
  return registry.get(normalizeShardBlockLanguage(lang))
}

export function hasBlockUI(lang: string) {
  return registry.has(normalizeShardBlockLanguage(lang))
}

export function listBlockUI(): { lang: string; ui: ShardBlockUI }[] {
  return Array.from(registry, ([lang, ui]) => ({ lang, ui }))
}

/** 注册顺序即菜单顺序：结构块排在行格式命令前面。 */
export function listBlockSlashItems(): { lang: string; slash: ShardBlockSlashItem }[] {
  return [...listBlockUI().flatMap(({ lang, ui }) =>
    ui.slash ? [{ lang, slash: ui.slash }] : []
  ), { lang: "", slash: {
    id: "dataset", label: "数据集", hint: "新建 CSV",
    keywords: ["数据集", "csv", "sjj", "dataset"], template: "",
  } }]
}

/** 匹配规则与 `filterSlashCommands` 一致：关键词小写后做 includes。 */
export function filterBlockSlashItems(query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return listBlockSlashItems()
  return listBlockSlashItems().filter(({ slash }) =>
    slash.keywords.some((keyword) => keyword.toLowerCase().includes(normalized))
  )
}

export function findBlockSlashItem(id: string) {
  return listBlockSlashItems().find(({ slash }) => slash.id === id)
}

// ---------------------------------------------------------------------------
// 大纲块
// ---------------------------------------------------------------------------

/** 幕布式大纲根节点输入框；插入 `/导图块` 后焦点直接落在这里。 */
const MIND_MAP_ROOT_INPUT_SELECTOR =
  '[data-outline-node][data-root="true"] textarea[data-outline-field="text"]'

function MindMapBlockEditor({ onChange, onExit, readOnly, source }: ShardBlockEditorProps) {
  // 长期会话、只在外部改动时重解析的逻辑全在 MindMapFenceWidget 里，
  // 与旧 CodeMirror widget 共用同一份组件，不再抄第二遍。
  return (
    <MindMapFenceWidget
      code={source}
      onChange={onChange}
      onExit={onExit}
      readOnly={readOnly}
      sourceStart={0}
    />
  )
}

function MindMapBlockPreview({ source }: ShardBlockPreviewProps) {
  return <MindMapFenceEmbed code={source} />
}

registerBlockUI(MIND_MAP_FENCE_LANGUAGE, {
  Editor: MindMapBlockEditor,
  Preview: MindMapBlockPreview,
  icon: GitBranchIcon,
  slash: {
    focusSelector: MIND_MAP_ROOT_INPUT_SELECTOR,
    hint: "mindmap",
    id: "mindmap",
    // 与 `src/lib/slash-commands.ts` 的 mindmap 条目保持同名同关键词：
    // 「大纲」只留给内容类型命令，围栏块叫「导图块」。
    keywords: ["导图块", "导图", "dtk", "dt", "mindmap", "mind"],
    label: "导图块",
    template: EMPTY_MIND_MAP_OUTLINE_SOURCE,
  },
})

// ---------------------------------------------------------------------------
// 数据表
// ---------------------------------------------------------------------------

function DatatableBlockEditor({ onChange, readOnly, source }: ShardBlockEditorProps) {
  return <DatatableBlock onChange={onChange} readOnly={readOnly} source={source} />
}

function DatatableBlockPreview({ source }: ShardBlockPreviewProps) {
  return <DatatableBlock readOnly source={source} />
}

registerBlockUI(DATATABLE_BLOCK_LANGUAGE, {
  Editor: DatatableBlockEditor,
  Preview: DatatableBlockPreview,
  icon: TableIcon,
  slash: {
    hint: "datatable",
    id: "datatable",
    keywords: ["数据表", "数据", "sjb", "sj", "datatable", "dataview"],
    label: "数据表",
    template: createDatatableTemplate(),
  },
})
