import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import Suggestion, { exitSuggestion } from "@tiptap/suggestion"

import {
  filterWikilinkCandidates,
  wikilinkCandidateDetail,
  type WikilinkCandidate,
} from "@/lib/wikilink"

import type { SuggestionMenuHost, SuggestionMenuItem } from "../suggestion/menu-host"
import { findWikilinkSuggestionMatch } from "../suggestion/inline-match"

export const WIKILINK_SUGGESTION_KEY = new PluginKey("shardRichWikilinkSuggestion")

const WIKILINK_SUGGESTION_ARIA_LABEL = "双链建议"

interface WikilinkSuggestionItem extends SuggestionMenuItem {
  target: string
}

export interface ShardWikilinkSuggestionOptions {
  getCandidates: () => readonly WikilinkCandidate[]
  menu: SuggestionMenuHost
}

/**
 * `[[` 双链建议。候选与徽标口径与 CM6 补全一致：宿主给出的碎片、笔记、
 * 大纲导图与 CSV 候选，按 `filterWikilinkCandidates` 过滤后最多 12 条，
 * 右侧徽标标出类别。选中后写入 `wikilink` 原子节点，编辑区里看不到方括号。
 */
export const ShardWikilinkSuggestion = Extension.create<ShardWikilinkSuggestionOptions>({
  name: "shardWikilinkSuggestion",

  addOptions() {
    return {
      getCandidates: () => [],
      menu: null as unknown as SuggestionMenuHost,
    }
  },

  addProseMirrorPlugins() {
    const { editor } = this
    const { getCandidates, menu } = this.options

    return [
      Suggestion<WikilinkSuggestionItem, WikilinkSuggestionItem>({
        char: "[[",
        editor,
        findSuggestionMatch: findWikilinkSuggestionMatch,
        pluginKey: WIKILINK_SUGGESTION_KEY,
        decorationClass: "shard-rich-suggestion-mark shard-rich-suggestion-mark--wikilink",
        // 组合输入期间不弹候选：拼音串既不是目标也不该被当成查询。
        allow: ({ state, range }) =>
          !editor.view.composing &&
          state.doc.resolve(range.from).parent.type.name !== "codeBlock",
        items: ({ query }) =>
          filterWikilinkCandidates(getCandidates(), query).map((candidate) => ({
            badge: wikilinkCandidateDetail(candidate.kind),
            key: `wikilink:${candidate.kind}:${candidate.target}`,
            label: candidate.label,
            target: candidate.target,
          })),
        command: ({ editor: instance, range, props }) => {
          const target = props.target.trim()
          if (!target) return

          // 别名沿用 `[[目标|别名]]` 的既有语义；从候选里选中时没有别名。
          instance
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: "wikilink", attrs: { alias: null, target } },
            ])
            .run()
        },
        render: () => ({
          onStart: (props) => {
            menu.open<WikilinkSuggestionItem>({
              ariaLabel: WIKILINK_SUGGESTION_ARIA_LABEL,
              items: props.items,
              onSelect: (item) => props.command(item),
              rect: props.clientRect?.() ?? null,
              source: "wikilink",
            })
          },
          onUpdate: (props) => {
            menu.update<WikilinkSuggestionItem>({
              ariaLabel: WIKILINK_SUGGESTION_ARIA_LABEL,
              items: props.items,
              onSelect: (item) => props.command(item),
              rect: props.clientRect?.() ?? null,
              source: "wikilink",
            })
          },
          onExit: () => menu.close("wikilink"),
          onKeyDown: ({ event }) => menu.handleKeyDown("wikilink", event),
        }),
      }),
      // 与标签建议同理：浮层挂在 body 上，失焦时没有事务，必须显式收起。
      new Plugin({
        key: new PluginKey("shardRichWikilinkSuggestionBlur"),
        props: {
          handleDOMEvents: {
            blur: (view) => {
              exitSuggestion(view, WIKILINK_SUGGESTION_KEY)
              return false
            },
          },
        },
      }),
    ]
  },
})
