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
      // 选区由 extensions/selection.ts 按行盒绘制；原生选区只留逻辑、不画背景。
      // 选区颜色保持迁移前的视觉语义。
      ".cm-content ::selection": {
        backgroundColor: "transparent",
      },
      ".shard-cm-selection": {
        backgroundColor: "rgb(17 19 21 / var(--shard-alpha-13))",
      },
      ".cm-placeholder": {
        color: "var(--muted-foreground)",
      },
      ".cm-tooltip.shard-cm-tag-tooltip": {
        background: "var(--popover)",
        border: "1px solid var(--border-visible)",
        borderRadius: "var(--shard-radius-control)",
        boxShadow: "var(--shard-shadow-popover)",
        color: "var(--popover-foreground)",
        fontFamily: "var(--shard-memo-font-family)",
        fontSize: "var(--text-meta)",
        maxWidth: "calc(100vw - var(--shard-space-6))",
        overflow: "hidden",
        width: "calc(var(--shard-space-6) * 10)",
      },
      ".cm-tooltip.shard-cm-tag-tooltip > ul": {
        // CM baseTheme 给 .cm-tooltip-autocomplete > ul 写死了 monospace 和
        // min-width: 250px，优先级高于 tooltip 上的声明：字体要在 ul 上再覆盖，
        // 最小宽度要归零，否则 ul 比 tooltip 宽、右侧的「使用 / 新建」徽标被裁掉
        boxSizing: "border-box",
        fontFamily: "var(--shard-memo-font-family)",
        listStyle: "none",
        minWidth: "0",
        width: "100%",
        margin: "0",
        maxHeight: "calc(var(--shard-space-8) * 7.5)",
        overflowY: "auto",
        padding: "var(--shard-space-1)",
      },
      ".cm-tooltip.shard-cm-tag-tooltip > ul > li[role='option']": {
        alignItems: "center",
        borderRadius: "var(--shard-radius-control)",
        color: "var(--popover-foreground)",
        cursor: "pointer",
        display: "flex",
        gap: "var(--shard-space-2)",
        lineHeight: "var(--shard-space-5)",
        minHeight: "calc(var(--shard-space-5) * 2)",
        padding: "0 var(--shard-space-2)",
      },
      ".cm-tooltip.shard-cm-tag-tooltip > ul > li[role='option'][aria-selected='true']": {
        background: "var(--accent)",
        color: "var(--accent-foreground)",
      },
      ".cm-tooltip.shard-cm-tag-tooltip .cm-completionLabel": {
        flex: "1 1 0%",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      ".cm-tooltip.shard-cm-tag-tooltip .cm-completionMatchedText": {
        fontWeight: "inherit",
        textDecoration: "none",
      },
      // detail 只保留给补全语义；可见徽标由 addToOptions 统一渲染，避免重复“新建”。
      ".cm-tooltip.shard-cm-tag-tooltip .cm-completionDetail": {
        display: "none",
      },
      ".cm-tooltip.shard-cm-tag-tooltip .shard-cm-tag-completion-badge": {
        color: "var(--muted-foreground)",
        flexShrink: "0",
        fontSize: "var(--text-tiny)",
        fontWeight: "var(--weight-regular)",
        lineHeight: "1",
        marginLeft: "auto",
      },
      ".shard-cm-tag": {
        color: "var(--shard-editor-tag-fg)",
      },
      ".shard-cm-highlight": {
        background: "rgb(var(--shard-warning-rgb) / var(--shard-alpha-21))",
        borderRadius: "calc(var(--shard-radius-control) / 2)",
        boxDecorationBreak: "clone",
        paddingBlock: "var(--shard-editor-highlight-pad-y)",
        WebkitBoxDecorationBreak: "clone",
      },
      ".shard-cm-strong": {
        fontWeight: "var(--weight-semibold)",
      },
      ".shard-cm-underline": {
        textDecoration: "underline",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--shard-caret-color)",
        borderLeftWidth: "var(--shard-caret-width)",
      },
    }),
  ]
}
