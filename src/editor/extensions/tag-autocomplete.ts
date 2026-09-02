import {
  autocompletion,
  closeCompletion,
  pickedCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionSource,
} from "@codemirror/autocomplete"
import { Transaction, type Extension } from "@codemirror/state"
import { EditorView, ViewPlugin, tooltips } from "@codemirror/view"

import { textEditToTransaction } from "@/editor/text-edit"
import {
  applyTagCompletion,
  getActiveTag,
  normalizeTag,
  normalizeTagList,
} from "@/lib/editor-format"
import { isTypeTag } from "@/lib/content-kind"
import { LOCKBOX_TAG } from "@/lib/lockbox"
import {
  buildTagSearchIndex,
  getMatchingTagsBySearchQuery,
  type TagSearchEntry,
} from "@/lib/tag-index"

interface ShardTagAutocompleteOptions {
  additionalSources?: CompletionSource[]
  getKnownTags: () => string[]
}

const MAX_TAG_SUGGESTIONS = 8
const TAG_COMPLETION_TYPE = "shard-tag"
const NEW_TAG_COMPLETION_TYPE = "shard-tag-new"

function isNewTagCompletion(completion: Completion) {
  return completion.type === NEW_TAG_COMPLETION_TYPE
}

function renderTagBadge(completion: Completion) {
  const badge = document.createElement("span")
  badge.className = "shard-cm-tag-completion-badge"
  badge.textContent = isNewTagCompletion(completion)
    ? "新建"
    : completion.label === LOCKBOX_TAG
      ? "保存到密匣"
      : "使用"
  return badge
}

function applyCompletion(
  view: EditorView,
  completion: Completion,
  _from: number,
  to: number,
) {
  const value = view.state.doc.toString()
  const activeTag = getActiveTag(value, to)
  if (!activeTag) return

  const edit = applyTagCompletion(value, activeTag, completion.label)
  if (!edit) return

  view.dispatch({
    ...textEditToTransaction(view.state, edit),
    annotations: [
      pickedCompletion.of(completion),
      Transaction.userEvent.of("input.complete"),
    ],
  })
}

function createCompletionListA11yPlugin() {
  return ViewPlugin.fromClass(
    class {
      private readonly observer: MutationObserver

      constructor(private readonly view: EditorView) {
        this.observer = new MutationObserver(() => this.labelListbox())
        // 补全面板挂在 body（见上面 tooltips 的理由），不再是 view.dom 的后代，
        // 所以要盯着面板真正的宿主，否则永远等不到它出现。
        this.observer.observe(this.tooltipHost(), {
          childList: true,
          subtree: true,
        })
        this.labelListbox()
      }

      update() {
        this.labelListbox()
      }

      destroy() {
        this.observer.disconnect()
      }

      private tooltipHost() {
        return this.view.dom.ownerDocument.body
      }

      private labelListbox() {
        this.tooltipHost()
          .querySelectorAll<HTMLElement>(
            ".cm-tooltip-autocomplete > ul[role='listbox']",
          )
          .forEach((listbox) => listbox.setAttribute("aria-label", "标签建议"))
      }
    },
  )
}

function createCompositionBoundary() {
  return EditorView.domEventHandlers({
    compositionstart: (_event, view) => {
      closeCompletion(view)
      // 只关闭补全，不截断 CM 自己的 compositionstart 处理链。
      return false
    },
    compositionend: (_event, view) => {
      queueMicrotask(() => {
        if (!view.composing) startCompletion(view)
      })
      return false
    },
  })
}

export function createShardTagAutocomplete({
  additionalSources = [],
  getKnownTags,
}: ShardTagAutocompleteOptions): Extension {
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

  const tagSource = (context: CompletionContext) => {
    if (context.view?.composing) return null

    const activeTag = getActiveTag(context.state.doc.toString(), context.pos)
    if (!activeTag) return null

    const query = normalizeTag(activeTag.query)
    const index = getTagIndex()
    const matches = getMatchingTagsBySearchQuery(
      index,
      query,
      MAX_TAG_SUGGESTIONS,
    )
    const options: Completion[] = matches.map((tag) => ({
      apply: applyCompletion,
      label: tag,
      type: TAG_COMPLETION_TYPE,
    }))

    if (
      query.length > 0 &&
      !isTypeTag(query) &&
      !normalizedKnownTags.includes(query)
    ) {
      options.push({
        apply: applyCompletion,
        detail: "新建",
        label: query,
        type: NEW_TAG_COMPLETION_TYPE,
      })
    }

    return {
      filter: false,
      from: activeTag.hashStart,
      options,
      to: context.pos,
    }
  }

  return [
    // 补全面板挂到 body：它默认是 .cm-editor 的子节点，而编辑器视口
    // （.codeMirrorViewport）overflow:hidden——面板即使 position:fixed 也会被
    // 那条裁切链切断，候选项一多就只露出上半截（在捕捉框里被工具栏切平）。
    tooltips({ parent: document.body, position: "fixed" }),
    autocompletion({
      activateOnTyping: true,
      addToOptions: [{ position: 80, render: renderTagBadge }],
      closeOnBlur: true,
      defaultKeymap: true,
      icons: false,
      // CM 默认在候选刚出现的 75ms 内忽略 Enter（防误触）——那会让「打完标签立刻回车」
      // 时而补全、时而换行。旧弹层是候选一出现 Enter 就选中，保持一致。
      interactionDelay: 0,
      optionClass: (completion) =>
        isNewTagCompletion(completion)
          ? "shard-cm-tag-completion shard-cm-tag-completion--new"
          : "shard-cm-tag-completion",
      override: [tagSource, ...additionalSources],
      tooltipClass: () => "shard-cm-tag-tooltip",
    }),
    createCompletionListA11yPlugin(),
    createCompositionBoundary(),
  ]
}
