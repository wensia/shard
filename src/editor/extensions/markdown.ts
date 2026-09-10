import {
  Language,
  LanguageSupport,
  defineLanguageFacet,
  languageDataProp,
} from "@codemirror/language"
import { markdownParser } from "@shard/markdown/core"

export { ShardHighlight, shardMarkdownParser } from "@shard/markdown/core"

const markdownLanguageData = defineLanguageFacet({
  commentTokens: { block: { close: "-->", open: "<!--" } },
})

// CodeMirror metadata belongs to the editor adapter, not the reusable parser.
const editorMarkdownParser = markdownParser.configure({
  props: [
    languageDataProp.add((type) =>
      type.isTop ? markdownLanguageData : undefined,
    ),
  ],
})

export const shardMarkdownLanguage = new Language(
  markdownLanguageData,
  editorMarkdownParser,
  [],
  "markdown",
)

export function createShardMarkdown() {
  return new LanguageSupport(shardMarkdownLanguage)
}
