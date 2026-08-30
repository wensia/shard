import {
  Language,
  LanguageSupport,
  defineLanguageFacet,
  languageDataProp,
} from "@codemirror/language"
import {
  GFM,
  parser as commonmarkParser,
  type MarkdownConfig,
  type MarkdownParser,
} from "@lezer/markdown"

const HighlightDelimiter = {
  mark: "HighlightMark",
}

/** Shard 的 `==荧光==` 行内语法；定界规则与 Lezer Strikethrough 保持一致。 */
export const ShardHighlight: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight" },
    { name: "HighlightMark" },
  ],
  parseInline: [
    {
      name: "Highlight",
      parse(context, next, position) {
        if (
          next !== 61 ||
          context.char(position + 1) !== 61 ||
          context.char(position + 2) === 61
        ) {
          return -1
        }

        const before = context.slice(position - 1, position)
        const after = context.slice(position + 2, position + 3)
        const whitespaceBefore = /\s|^$/u.test(before)
        const whitespaceAfter = /\s|^$/u.test(after)
        const punctuationBefore = /[!-/:-@[-`{-~\p{P}\p{S}]/u.test(before)
        const punctuationAfter = /[!-/:-@[-`{-~\p{P}\p{S}]/u.test(after)

        const canOpen =
          !whitespaceAfter &&
          (!punctuationAfter || whitespaceBefore || punctuationBefore)
        const canClose =
          !whitespaceBefore &&
          (!punctuationBefore || whitespaceAfter || punctuationAfter)
        const openingIndex = canClose
          ? context.findOpeningDelimiter(HighlightDelimiter)
          : null
        const opening =
          openingIndex === null ? null : context.getDelimiterAt(openingIndex)

        // Markdown 的 paragraph inline stream 可跨软换行；Shard 的荧光语法不跨行。
        if (
          openingIndex !== null &&
          opening &&
          opening.to < position &&
          !context.slice(opening.to, position).includes("\n")
        ) {
          const content = context.takeContent(openingIndex)
          return context.addElement(
            context.elt("Highlight", opening.from, position + 2, [
              context.elt("HighlightMark", opening.from, opening.to),
              ...content,
              context.elt("HighlightMark", position, position + 2),
            ]),
          )
        }

        return canOpen
          ? context.addDelimiter(
              HighlightDelimiter,
              position,
              position + 2,
              true,
              false,
            )
          : -1
      },
      after: "Emphasis",
    },
  ],
}

const markdownLanguageData = defineLanguageFacet({
  commentTokens: { block: { close: "-->", open: "<!--" } },
})

/**
 * 编辑器与只读卡片共用的 Markdown 解析器：CommonMark + GFM（任务列表、表格、
 * 删除线、自动链接）+ Shard 的 `==荧光==`。
 *
 * 故意不用 `@codemirror/lang-markdown`：它硬依赖 `@codemirror/lang-html`，会把
 * HTML / CSS / JavaScript 三套解析器一起打进 bundle（gzip 约 +80KB），而 Shard
 * 不做代码块语法高亮，只需要语法树来放 decoration。
 */
export const shardMarkdownParser: MarkdownParser = commonmarkParser.configure([
  GFM,
  ShardHighlight,
  {
    props: [
      languageDataProp.add((type) =>
        type.isTop ? markdownLanguageData : undefined,
      ),
    ],
  },
])

export const shardMarkdownLanguage = new Language(
  markdownLanguageData,
  shardMarkdownParser,
  [],
  "markdown",
)

export function createShardMarkdown() {
  return new LanguageSupport(shardMarkdownLanguage)
}
