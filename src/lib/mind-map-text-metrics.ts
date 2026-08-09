import { useEffect, useState, type RefObject } from "react"

// SVG 没有可靠的跨引擎垂直居中基元：dominant-baseline 在 WKWebView 不生效，
// dy="0.28em" 之类的魔法偏移随字体/字号变化。这里用 Canvas 2D 实测字形指标，
// 让渲染态（SVG tspan 显式基线）和编辑态（HTML textarea 半行距）以同一套
// 墨盒数据对齐，保证两种状态、两种引擎下文字位置一致。
const PROBE_TEXT = "永Ag"
const FALLBACK_OFFSET_RATIO = 0.35

const offsetCache = new Map<string, number>()

let measureContext: CanvasRenderingContext2D | null | undefined

function getMeasureContext() {
  if (measureContext === undefined) {
    measureContext = document.createElement("canvas").getContext("2d")
  }
  return measureContext
}

function measure(
  fontFamily: string,
  fontSize: number,
  fontWeight: string,
  text: string
) {
  const context = getMeasureContext()
  if (!context || !fontFamily) return null

  context.font = `${fontWeight} ${fontSize}px ${fontFamily}`
  return context.measureText(text || PROBE_TEXT)
}

// 指定文本的墨盒中心到其字母基线的距离（基线在墨盒中心下方，值为正）。
// 渲染态用它把每行基线放在 行中心 + offset，使墨盒恰好居中。
export function measureMindMapInkBaselineOffset(
  fontFamily: string,
  fontSize: number,
  fontWeight: string,
  text: string
): number {
  const cacheKey = `${fontFamily}|${fontWeight}|${fontSize}|${text}`
  const cached = offsetCache.get(cacheKey)
  if (cached !== undefined) return cached

  const metrics = measure(fontFamily, fontSize, fontWeight, text)
  let offset = fontSize * FALLBACK_OFFSET_RATIO
  if (
    metrics &&
    metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent > 0
  ) {
    offset =
      (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2
  }

  offsetCache.set(cacheKey, offset)
  return offset
}

// 容器挂载后读取其实际 font-family；网络字体（Noto Sans SC）加载完成后再读一次。
export function useMindMapFontFamily(
  containerRef: RefObject<HTMLElement | null>
) {
  const [fontFamily, setFontFamily] = useState<string | null>(null)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const read = () => setFontFamily(getComputedStyle(element).fontFamily)
    read()

    let cancelled = false
    void document.fonts?.ready.then(() => {
      if (!cancelled) read()
    })
    return () => {
      cancelled = true
    }
  }, [containerRef])

  return fontFamily
}
