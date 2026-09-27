import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import Suggestion, { exitSuggestion } from "@tiptap/suggestion"

import {
  filterSlashCommands,
  isContentTypeSlashCommand,
  isDocumentTierSlashCommand,
  type SlashCommandId,
} from "@/lib/slash-commands"

import {
  filterBlockSlashItems,
  listBlockSlashItems,
} from "../blocks/registry-ui"
import {
  RICH_SLASH_COMMAND_IDS,
  runRichSlashCommand,
  type ShardRichHostCommands,
} from "../commands"
import type { SuggestionMenuHost, SuggestionMenuItem } from "../suggestion/menu-host"
import { findSlashSuggestionMatch } from "../suggestion/inline-match"

export const SLASH_SUGGESTION_KEY = new PluginKey("shardRichSlashSuggestion")

const SLASH_SUGGESTION_ARIA_LABEL = "命令菜单"

interface SlashSuggestionItem extends SuggestionMenuItem {
  id: string
}

export interface ShardSlashSuggestionOptions {
  menu: SuggestionMenuHost
  onImageFiles?: (files: File[]) => void
  /** 宿主接手的内容类型命令；没给的那条不进菜单（`/大纲`、`/文档`）。 */
  getHostCommands?: () => ShardRichHostCommands
  /** 文档档才展示标题、引用、代码块；基础档不传或返回 false。 */
  isDocumentTier?: () => boolean
  allowDatasetActions?: () => boolean
}

/**
 * `/` 命令菜单。两个来源合成一份候选：围栏块 UI 注册表提供的块命令（大纲导图、
 * 数据表……）排在前面，`src/lib/slash-commands.ts` 的行格式命令跟在后面。
 * 同 id 以块注册表为准，菜单里不会出现两条重复候选——新增一个围栏块因此
 * 不需要改这里的任何代码。
 */
export const ShardSlashSuggestion = Extension.create<ShardSlashSuggestionOptions>({
  name: "shardSlashSuggestion",

  addOptions() {
    return {
      menu: null as unknown as SuggestionMenuHost,
      onImageFiles: undefined,
      getHostCommands: undefined,
      isDocumentTier: undefined,
      allowDatasetActions: undefined,
    }
  },

  addProseMirrorPlugins() {
    const { editor } = this
    const { menu } = this.options
    const getImageHandler = () => this.options.onImageFiles
    const getHostCommands = (): ShardRichHostCommands =>
      this.options.getHostCommands?.() ?? {}
    const supportsContentType = (id: SlashCommandId) => {
      const host = getHostCommands()
      return Boolean(id === "outline" ? host.onEnterOutline : host.onMarkDocument)
    }
    const isDocumentTier = () => this.options.isDocumentTier?.() ?? false

    return [
      Suggestion<SlashSuggestionItem, SlashSuggestionItem>({
        char: "/",
        editor,
        findSuggestionMatch: findSlashSuggestionMatch,
        pluginKey: SLASH_SUGGESTION_KEY,
        decorationClass: "shard-rich-suggestion-mark",
        allow: ({ state, range }) =>
          !editor.view.composing &&
          state.doc.resolve(range.from).parent.type.name !== "codeBlock",
        items: ({ query }) => {
          const claimed = new Set(listBlockSlashItems().map((item) => item.slash.id))
          const blocks = filterBlockSlashItems(query)
            .filter(({ slash }) => slash.id !== "dataset" || (this.options.allowDatasetActions?.() ?? true))
            .map(({ slash }) => ({
            badge: slash.hint,
            id: slash.id,
            key: `block:${slash.id}`,
            label: slash.label,
          }))
          const builtin = filterSlashCommands(query)
            .filter(
              (command) =>
                RICH_SLASH_COMMAND_IDS.has(command.id) &&
                !claimed.has(command.id) &&
                (!isContentTypeSlashCommand(command.id) ||
                  supportsContentType(command.id)) &&
                (!isDocumentTierSlashCommand(command.id) || isDocumentTier())
            )
            .map((command) => ({
              badge: command.hint,
              id: command.id,
              key: `slash:${command.id}`,
              label: command.label,
            }))
          return [...blocks, ...builtin]
        },
        command: ({ editor: instance, range, props }) => {
          // 命令文本先从文档里摘掉，命令本身只看到「干净」的正文与光标。
          instance.chain().focus().deleteRange(range).run()
          runRichSlashCommand(instance, props.id, getImageHandler(), getHostCommands())
        },
        render: () => ({
          onStart: (props) => {
            menu.open<SlashSuggestionItem>({
              ariaLabel: SLASH_SUGGESTION_ARIA_LABEL,
              items: props.items,
              onSelect: (item) => props.command(item),
              rect: props.clientRect?.() ?? null,
              source: "slash",
            })
          },
          onUpdate: (props) => {
            menu.update<SlashSuggestionItem>({
              ariaLabel: SLASH_SUGGESTION_ARIA_LABEL,
              items: props.items,
              onSelect: (item) => props.command(item),
              rect: props.clientRect?.() ?? null,
              source: "slash",
            })
          },
          onExit: () => menu.close("slash"),
          onKeyDown: ({ event }) => menu.handleKeyDown("slash", event),
        }),
      }),
      // 同标签建议：浮层在 body 上，失焦时没有事务，必须显式收起。
      new Plugin({
        key: new PluginKey("shardRichSlashSuggestionBlur"),
        props: {
          handleDOMEvents: {
            blur: (view) => {
              exitSuggestion(view, SLASH_SUGGESTION_KEY)
              return false
            },
          },
        },
      }),
    ]
  },
})
