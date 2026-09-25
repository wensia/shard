import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import Suggestion, { exitSuggestion } from "@tiptap/suggestion"

import { isTypeTag } from "@/lib/content-kind"
import { normalizeTag, normalizeTagList } from "@/lib/editor-format"
import { LOCKBOX_TAG } from "@/lib/lockbox"
import {
  buildTagSearchIndex,
  getMatchingTagsBySearchQuery,
  type TagSearchEntry,
} from "@/lib/tag-index"

import type { SuggestionMenuHost, SuggestionMenuItem } from "../suggestion/menu-host"
import { characterAfter, findTagSuggestionMatch } from "../suggestion/inline-match"

export const TAG_SUGGESTION_KEY = new PluginKey("shardRichTagSuggestion")

const MAX_TAG_SUGGESTIONS = 8
const TAG_SUGGESTION_ARIA_LABEL = "标签建议"

interface TagSuggestionItem extends SuggestionMenuItem {
  tag: string
}

export interface ShardTagSuggestionOptions {
  getKnownTags: () => string[]
  menu: SuggestionMenuHost
}

/**
 * `#` 标签建议。候选与徽标口径与旧 CodeMirror 补全一致：
 * 最多 8 条已知标签（`getMatchingTagsBySearchQuery` 按原文、全拼、首字母、混拼分档排序），
 * 查询不在已知标签里时再追加一条「新建」；`#密匣` 是保存目的地指令，徽标另标。
 */
export const ShardTagSuggestion = Extension.create<ShardTagSuggestionOptions>({
  name: "shardTagSuggestion",

  addOptions() {
    return {
      getKnownTags: () => [],
      menu: null as unknown as SuggestionMenuHost,
    }
  },

  addProseMirrorPlugins() {
    const { editor } = this
    const { getKnownTags, menu } = this.options

    let cachedTags: string[] | null = null
    let normalizedKnownTags: string[] = []
    let tagSearchIndex: TagSearchEntry[] = []

    const getTagIndex = () => {
      const knownTags = getKnownTags()
      if (knownTags !== cachedTags) {
        cachedTags = knownTags
        normalizedKnownTags = normalizeTagList(knownTags)
        tagSearchIndex = buildTagSearchIndex(normalizedKnownTags)
      }
      return tagSearchIndex
    }

    return [
      Suggestion<TagSuggestionItem, TagSuggestionItem>({
        char: "#",
        editor,
        findSuggestionMatch: findTagSuggestionMatch,
        pluginKey: TAG_SUGGESTION_KEY,
        decorationClass: "shard-rich-suggestion-mark shard-rich-suggestion-mark--tag",
        // 组合输入期间不弹候选：中文拼音串既不是标签也不该被当成查询。
        allow: ({ state, range }) =>
          !editor.view.composing &&
          state.doc.resolve(range.from).parent.type.name !== "codeBlock",
        items: ({ query }) => {
          const normalized = normalizeTag(query)
          const matches = getMatchingTagsBySearchQuery(
            getTagIndex(),
            normalized,
            MAX_TAG_SUGGESTIONS
          )
          const items: TagSuggestionItem[] = matches.map((tag) => ({
            badge: tag === LOCKBOX_TAG ? "保存到密匣" : "使用",
            key: `tag:${tag}`,
            label: tag,
            tag,
          }))

          if (
            normalized.length > 0 &&
            !isTypeTag(normalized) &&
            !normalizedKnownTags.includes(normalized)
          ) {
            items.push({
              badge: "新建",
              key: `new:${normalized}`,
              label: normalized,
              tag: normalized,
            })
          }

          return items
        },
        command: ({ editor: instance, range, props }) => {
          const tag = normalizeTag(props.tag)
          if (!tag) return

          // 标签后面必须留一个可见空格（flomo 式间隔），已有空白就不重复补。
          const after = characterAfter(instance.state.doc.resolve(range.to))
          const content: Record<string, unknown>[] = [
            { type: "tag", attrs: { name: tag } },
          ]
          if (!/^[^\S\r\n]/u.test(after)) content.push({ type: "text", text: " " })

          instance.chain().focus().insertContentAt(range, content).run()
        },
        render: () => ({
          onStart: (props) => {
            menu.open<TagSuggestionItem>({
              ariaLabel: TAG_SUGGESTION_ARIA_LABEL,
              items: props.items,
              onSelect: (item) => props.command(item),
              rect: props.clientRect?.() ?? null,
              source: "tag",
            })
          },
          onUpdate: (props) => {
            menu.update<TagSuggestionItem>({
              ariaLabel: TAG_SUGGESTION_ARIA_LABEL,
              items: props.items,
              onSelect: (item) => props.command(item),
              rect: props.clientRect?.() ?? null,
              source: "tag",
            })
          },
          onExit: () => menu.close("tag"),
          onKeyDown: ({ event }) => menu.handleKeyDown("tag", event),
        }),
      }),
      // 浮层挂在 body，编辑器失焦时不会有新事务把它关掉；显式收起，
      // 与旧 CodeMirror 补全的 closeOnBlur 行为一致。
      new Plugin({
        key: new PluginKey("shardRichTagSuggestionBlur"),
        props: {
          handleDOMEvents: {
            blur: (view) => {
              exitSuggestion(view, TAG_SUGGESTION_KEY)
              return false
            },
          },
        },
      }),
    ]
  },
})
