import {
  EditorView,
  RectangleMarker,
  layer,
  type LayerMarker,
} from "@codemirror/view"

/**
 * 按「行盒」绘制选区（方案 §7 决策 C 的复评结果）。
 *
 * 原生 `::selection` 和 CM 自带的 `drawSelection()` 在首尾行都只盖到字符的
 * content area（约 20px），行高 25.2px 时上下各露一截，跨行断成横条——
 * 和迁移前覆盖层的老毛病一样。这里用 CM 的 layer API 自己画：每个视觉行
 * 一块，高度取该行的行盒，跨行时前一行延伸到内容右缘、后一行从左缘起，
 * 连成一整片（flomo / 原生 contenteditable 的观感）。
 *
 * 光标仍是浏览器原生的：自绘光标对 IME 没有任何好处，只会多一层对齐。
 */

interface LayerBase {
  left: number
  top: number
}

function getLayerBase(view: EditorView): LayerBase {
  const rect = view.scrollDOM.getBoundingClientRect()
  return {
    left: rect.left - view.scrollDOM.scrollLeft,
    top: rect.top - view.scrollDOM.scrollTop,
  }
}

function coordsAt(view: EditorView, pos: number, side: -1 | 1) {
  return view.coordsAtPos(pos, side) ?? view.coordsAtPos(pos, side === 1 ? -1 : 1)
}

function lineBoxSelectionMarkers(view: EditorView): readonly LayerMarker[] {
  const markers: RectangleMarker[] = []
  const base = getLayerBase(view)
  const contentRect = view.contentDOM.getBoundingClientRect()
  const contentStyle = getComputedStyle(view.contentDOM)
  const lineHeight =
    Number.parseFloat(contentStyle.lineHeight) || view.defaultLineHeight
  const leftEdge =
    contentRect.left + (Number.parseFloat(contentStyle.paddingLeft) || 0)
  const rightEdge =
    contentRect.right - (Number.parseFloat(contentStyle.paddingRight) || 0)

  for (const range of view.state.selection.ranges) {
    if (range.empty) continue

    let pos = range.from
    let guard = 0
    while (pos < range.to && guard < 10_000) {
      guard += 1
      const line = view.state.doc.lineAt(pos)
      const start = coordsAt(view, pos, 1)
      if (!start) {
        pos += 1
        continue
      }

      // 当前视觉行（软换行后的一行）到哪里结束：沿着字符中线往右缘探一下
      const centerY = (start.top + start.bottom) / 2
      const rowEnd = Math.min(
        view.posAtCoords({ x: rightEdge - 1, y: centerY }) ?? line.to,
        line.to,
      )
      const segmentEnd = Math.min(Math.max(rowEnd, pos), range.to)

      // 这一逻辑行是否只有一个视觉行：是则直接用行块（含 widget 撑高的行），
      // 否则用字符中线上下各半个行高。
      const block = view.lineBlockAt(pos)
      const firstCoords = coordsAt(view, line.from, 1)
      const firstRowEnd = firstCoords
        ? view.posAtCoords({
            x: rightEdge - 1,
            y: (firstCoords.top + firstCoords.bottom) / 2,
          })
        : null
      const singleRow = firstRowEnd === null || firstRowEnd >= line.to
      const top = singleRow
        ? view.documentTop + block.top - base.top
        : centerY - lineHeight / 2 - base.top
      const height = singleRow ? block.height : lineHeight

      const segmentLeft = pos === range.from ? start.left : leftEdge
      let segmentRight: number
      if (segmentEnd === range.to) {
        segmentRight = coordsAt(view, range.to, -1)?.left ?? rightEdge
      } else {
        // 选区继续到下一行：本行延伸到内容右缘，表示换行也在选区里
        segmentRight = rightEdge
      }
      if (segmentRight < segmentLeft) segmentRight = segmentLeft

      markers.push(
        new RectangleMarker(
          "shard-cm-selection",
          segmentLeft - base.left,
          top,
          Math.max(segmentRight - segmentLeft, 0),
          height,
        ),
      )

      if (segmentEnd >= range.to) break
      // 到了逻辑行尾就跳过换行符；视觉行尾则从下一视觉行继续
      pos = segmentEnd === line.to ? line.to + 1 : segmentEnd
      if (pos <= segmentEnd && segmentEnd !== line.to) pos = segmentEnd + 1
    }
  }

  return markers
}

export function createShardSelectionLayer() {
  return layer({
    above: false,
    class: "shard-cm-selection-layer",
    markers: lineBoxSelectionMarkers,
    update: (update) =>
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      update.geometryChanged,
  })
}
