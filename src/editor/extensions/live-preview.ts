import { syntaxTree } from "@codemirror/language"
import { isolateHistory } from "@codemirror/commands"
import {
  Compartment,
  StateEffect,
  Transaction,
  type EditorSelection,
  type Range,
} from "@codemirror/state"
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view"

import {
  getTagRanges,
  normalizeTag,
  parseMarkdownImageLine,
} from "@/lib/editor-format"
import { markdownTaskFromNode } from "@/lib/markdown-tasks"
import { LOCKBOX_TAG } from "@/lib/lockbox"
import { loadFragmentImageSrc } from "@/lib/fragment-images"

const refreshLivePreviewEffect = StateEffect.define<null>()

export const shardLivePreviewCompartment = new Compartment()

function selectionIntersects(
  selection: EditorSelection,
  from: number,
  to: number,
) {
  const main = selection.main
  return main.empty
    ? main.from >= from && main.from < to
    : main.from < to && main.to > from
}

function selectionTouchesLine(
  selection: EditorSelection,
  from: number,
  to: number,
) {
  const main = selection.main
  return main.empty
    ? main.from >= from && main.from <= to
    : main.from <= to && main.to >= from
}

function lineRanges(view: EditorView) {
  const ranges: Array<{ from: number; to: number }> = []
  for (const range of view.visibleRanges) {
    const from = view.state.doc.lineAt(range.from).from
    const to = view.state.doc.lineAt(range.to).to
    const previous = ranges[ranges.length - 1]
    if (previous && from <= previous.to + 1) {
      previous.to = Math.max(previous.to, to)
    } else {
      ranges.push({ from, to })
    }
  }
  return ranges
}

class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly markerOffset: number,
    readonly readOnly: boolean,
  ) {
    super()
  }

  eq(other: TaskCheckboxWidget) {
    return this.checked === other.checked &&
      this.markerOffset === other.markerOffset &&
      this.readOnly === other.readOnly
  }

  toDOM(view: EditorView) {
    const marker = document.createElement("span")
    marker.className = "shard-task-marker shard-cm-task-marker"
    const checkbox = document.createElement("span")
    checkbox.className = [
      "shard-task-checkbox",
      "shard-cm-task-checkbox",
      this.checked ? "shard-task-checkbox-checked" : "",
    ]
      .filter(Boolean)
      .join(" ")
    checkbox.setAttribute("aria-label", this.checked ? "标记为未完成" : "标记为完成")
    checkbox.setAttribute("aria-checked", String(this.checked))
    checkbox.setAttribute("aria-readonly", String(this.readOnly))
    checkbox.setAttribute("role", "checkbox")
    checkbox.tabIndex = this.readOnly ? -1 : 0

    const toggle = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      if (view.state.readOnly || view.composing) return
      // 从当前 widget 位置定位，避免上方插入/删除行后写到旧偏移；只改状态字符。
      const markerFrom = view.posAtDOM(marker) + this.markerOffset
      const current = view.state.doc.sliceString(markerFrom, markerFrom + 3)
      if (!/^\[[ xX]\]$/u.test(current)) return
      view.dispatch({
        changes: {
          from: markerFrom + 1,
          to: markerFrom + 2,
          insert: current[1].toLowerCase() === "x" ? " " : "x",
        },
        annotations: [Transaction.userEvent.of("input.task"), isolateHistory.of("full")],
      })
      view.focus()
    }

    checkbox.addEventListener("mousedown", (event) => event.preventDefault())
    checkbox.addEventListener("click", toggle)
    checkbox.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") toggle(event)
    })
    marker.append(checkbox)
    return marker
  }

  ignoreEvent() {
    return true
  }
}

class DividerWidget extends WidgetType {
  eq() {
    return true
  }

  toDOM() {
    const divider = document.createElement("span")
    divider.className = "shard-fragment-divider shard-cm-divider"
    divider.setAttribute("aria-label", "分割线")
    divider.setAttribute("role", "separator")
    return divider
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly alt: string,
    readonly path: string,
  ) {
    super()
  }

  eq(other: ImageWidget) {
    return this.alt === other.alt && this.path === other.path
  }

  get estimatedHeight() {
    // 与只读卡片 86px 缩略图及上下留白对齐，先估高避免异步图片加载时跳动。
    return 98
  }

  toDOM(view: EditorView) {
    const row = document.createElement("span")
    row.className = "shard-image-attachment-row shard-cm-image-widget"

    const attachment = document.createElement("span")
    attachment.className = "shard-image-attachment"
    const preview = document.createElement("span")
    preview.className =
      "shard-image-attachment-preview shard-image-attachment-preview-readonly"
    const image = document.createElement("img")
    image.alt = this.alt
    image.dataset.sourcePath = this.path
    image.loading = "lazy"

    const showFailure = () => {
      preview.replaceChildren()
      const fallback = document.createElement("span")
      fallback.className = "shard-cm-image-fallback"
      fallback.textContent = this.alt || "图片加载失败"
      preview.append(fallback)
      view.requestMeasure()
    }

    image.addEventListener("load", () => view.requestMeasure())
    image.addEventListener("error", showFailure)
    preview.append(image)
    attachment.append(preview)
    row.append(attachment)

    void loadFragmentImageSrc(this.path)
      .then((source) => {
        if (source) image.src = source
        else showFailure()
      })
      .catch(showFailure)

    return row
  }
}

function buildLivePreviewDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = []
  const seen = new Set<string>()
  const htmlTags = new Set<string>()
  const imageNodes: Array<{ from: number; to: number }> = []
  const expandedRanges = lineRanges(view)

  const add = (key: string, range: Range<Decoration>) => {
    if (seen.has(key)) return
    seen.add(key)
    decorations.push(range)
  }

  for (const range of expandedRanges) {
    syntaxTree(view.state).iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        const key = `${node.name}:${node.from}:${node.to}`
        if (seen.has(`node:${key}`)) return
        seen.add(`node:${key}`)

        if (node.name === "HTMLTag") {
          htmlTags.add(`${node.from}:${node.to}`)
          return
        }
        if (node.name === "Image") {
          imageNodes.push({ from: node.from, to: node.to })
          return
        }

        if (node.name === "Highlight" || node.name === "StrongEmphasis") {
          const syntaxNode = node.node
          const openMark = syntaxNode.firstChild
          const closeMark = syntaxNode.lastChild
          const expectedMark =
            node.name === "Highlight" ? "HighlightMark" : "EmphasisMark"
          if (
            openMark?.name !== expectedMark ||
            closeMark?.name !== expectedMark ||
            openMark.to >= closeMark.from
          ) {
            return
          }

          const className =
            node.name === "Highlight" ? "shard-cm-highlight" : "shard-cm-strong"
          add(
            `mark:${className}:${openMark.to}:${closeMark.from}`,
            Decoration.mark({ class: className }).range(openMark.to, closeMark.from),
          )
          if (!selectionIntersects(view.state.selection, node.from, node.to)) {
            add(
              `replace:${openMark.from}:${openMark.to}`,
              Decoration.replace({}).range(openMark.from, openMark.to),
            )
            add(
              `replace:${closeMark.from}:${closeMark.to}`,
              Decoration.replace({}).range(closeMark.from, closeMark.to),
            )
          }
          return
        }

        if (node.name === "TaskMarker") {
          const task = markdownTaskFromNode(node.node, (from, to) =>
            view.state.doc.sliceString(from, to),
          )
          if (!task) return
          add(
            `task:${task.from}:${task.to}:${task.checked}`,
            Decoration.replace({
              widget: new TaskCheckboxWidget(
                task.checked,
                task.markerFrom - task.from,
                view.state.readOnly,
              ),
            }).range(task.from, task.to),
          )
          return
        }

        if (node.name === "HorizontalRule") {
          const line = view.state.doc.lineAt(node.from)
          if (selectionTouchesLine(view.state.selection, line.from, line.to)) return
          add(
            `divider:${line.from}:${line.to}`,
            Decoration.replace({ widget: new DividerWidget() }).range(line.from, line.to),
          )
        }
      },
    })
  }

  for (const range of expandedRanges) {
    let line = view.state.doc.lineAt(range.from)
    while (line.from <= range.to) {
      const lineText = line.text

      for (const tag of getTagRanges(lineText)) {
        const from = line.from + tag.start
        const to = line.from + tag.end
        // #密匣 是保存目的地指令而非分类标签，用密匣的琥珀色与普通标签区分
        const tagClass =
          normalizeTag(tag.text) === LOCKBOX_TAG
            ? "shard-cm-tag shard-cm-tag-lockbox"
            : "shard-cm-tag"
        add(
          `tag:${from}:${to}`,
          Decoration.mark({ class: tagClass }).range(from, to),
        )
      }

      for (const match of lineText.matchAll(/<u>(.*?)<\/u>/gu)) {
        const start = line.from + (match.index ?? 0)
        const openTo = start + 3
        const closeFrom = start + match[0].length - 4
        const end = closeFrom + 4
        if (
          !htmlTags.has(`${start}:${openTo}`) ||
          !htmlTags.has(`${closeFrom}:${end}`)
        ) {
          continue
        }
        add(
          `underline:${openTo}:${closeFrom}`,
          Decoration.mark({ class: "shard-cm-underline" }).range(openTo, closeFrom),
        )
        if (!selectionIntersects(view.state.selection, start, end)) {
          add(
            `replace:${start}:${openTo}`,
            Decoration.replace({}).range(start, openTo),
          )
          add(
            `replace:${closeFrom}:${end}`,
            Decoration.replace({}).range(closeFrom, end),
          )
        }
      }

      const image = parseMarkdownImageLine(lineText)
      const lineTags = getTagRanges(lineText)
      const parsedAsImage = imageNodes.some(
        (node) => node.from >= line.from && node.to <= line.to,
      )
      if (
        image &&
        parsedAsImage &&
        lineTags.length === 0 &&
        !selectionTouchesLine(view.state.selection, line.from, line.to)
      ) {
        // 不能用 block 装饰：CM6 规定 block decoration 只能来自 StateField，
        // ViewPlugin 提供会直接抛错。整行替换成行内 widget 即可，行高随 widget 走。
        add(
          `image:${line.from}:${line.to}:${image.path}`,
          Decoration.replace({
            widget: new ImageWidget(image.alt, image.path),
          }).range(line.from, line.to),
        )
      }

      if (line.to >= range.to || line.number >= view.state.doc.lines) break
      line = view.state.doc.line(line.number + 1)
    }
  }

  return Decoration.set(decorations, true)
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    taskRanges: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildLivePreviewDecorations(view)
      this.taskRanges = this.getTaskRanges()
    }

    getTaskRanges() {
      return this.decorations.update({
        filter: (_from, _to, decoration) => decoration.spec.widget instanceof TaskCheckboxWidget,
      })
    }

    update(update: ViewUpdate) {
      const refreshRequested = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(refreshLivePreviewEffect)),
      )
      if (
        !refreshRequested &&
        !update.docChanged &&
        !update.viewportChanged &&
        !update.selectionSet &&
        update.startState.readOnly === update.state.readOnly &&
        syntaxTree(update.startState) === syntaxTree(update.state)
      ) {
        return
      }
      // IME composed state 期间只映射旧 DecorationSet，不能调用 builder 重算语法。
      if (update.view.composing) {
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes)
          this.taskRanges = this.taskRanges.map(update.changes)
        }
        return
      }
      this.decorations = buildLivePreviewDecorations(update.view)
      this.taskRanges = this.getTaskRanges()
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    // 隐藏的任务前缀作为整体移动光标，不能把输入落在看不见的 Markdown 中间。
    provide: (plugin) => EditorView.atomicRanges.of((view) =>
      view.plugin(plugin)?.taskRanges ?? Decoration.none,
    ),
  },
)

const compositionRefresh = EditorView.domEventHandlers({
  compositionend: (_event, view) => {
    queueMicrotask(() => {
      if (!view.composing) view.dispatch({ effects: refreshLivePreviewEffect.of(null) })
    })
    return false
  },
})

export function createShardLivePreview() {
  // 本地调试 kill switch，不进入产品 UI；刷新编辑器后生效。
  const disabled =
    typeof localStorage !== "undefined" &&
    localStorage.getItem("shard.editorDecorations") === "off"
  return shardLivePreviewCompartment.of(
    disabled ? [] : [livePreviewPlugin, compositionRefresh],
  )
}
