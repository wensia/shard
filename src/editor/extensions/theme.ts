import { EditorView } from "@codemirror/view"

import type { ShardEditorProps } from "@/editor/shard-editor"

const shardEditorBaseTheme = EditorView.baseTheme({
  "&": {
    backgroundColor: "transparent",
    height: "auto",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    overflow: "visible",
  },
  ".cm-gutters": {
    display: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-line": {
    padding: "0",
  },
})

export function createShardEditorTheme(variant: ShardEditorProps["variant"]) {
  const contentPadding =
    variant === "composer" ? "var(--shard-composer-padding)" : "0"

  return [
    shardEditorBaseTheme,
    EditorView.theme({
      "&": {
        color: "var(--shard-memo-content-color)",
        fontFamily: "var(--shard-memo-font-family)",
        fontSize: "var(--shard-editor-font-size)",
        fontWeight: "var(--shard-editor-font-weight)",
        letterSpacing: "var(--shard-editor-letter-spacing)",
        lineHeight: "var(--shard-editor-line-height)",
      },
      ".cm-content": {
        caretColor: "var(--shard-caret-color)",
        fontFamily: "var(--shard-memo-font-family)",
        fontSize: "var(--shard-editor-font-size)",
        fontWeight: "var(--shard-editor-font-weight)",
        letterSpacing: "var(--shard-editor-letter-spacing)",
        lineHeight: "var(--shard-editor-line-height)",
        minHeight: "inherit",
        padding: contentPadding,
      },
      ".cm-content ::selection": {
        backgroundColor: "rgb(17 19 21 / var(--shard-alpha-13))",
      },
      ".cm-placeholder": {
        color: "var(--muted-foreground)",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--shard-caret-color)",
        borderLeftWidth: "var(--shard-caret-width)",
      },
    }),
  ]
}
