import { useEffect, useMemo, useState } from "react"
import { ASYNC_MARKDOWN_THRESHOLD, parseMarkdown, type MarkdownParseRequest, type ParsedMarkdown } from "./parser.js"

interface ParseState {
  request: MarkdownParseRequest
  result?: ParsedMarkdown
  error?: Error
}

export function useMarkdown(kind: "content" | "document", content: string, hideTags = false, renderImages = false, compactParagraphs = false) {
  const request = useMemo<MarkdownParseRequest>(() => kind === "document"
    ? { kind, content }
    : { kind, content, hideTags, renderImages, compactParagraphs }, [kind, content, hideTags, renderImages, compactParagraphs])
  const asynchronous = content.length > ASYNC_MARKDOWN_THRESHOLD
  const synchronousResult = useMemo(() => asynchronous ? null : parseMarkdown(request), [asynchronous, request])
  const [state, setState] = useState<ParseState | null>(null)

  useEffect(() => {
    if (!asynchronous) {
      setState(null)
      return
    }
    let active = true
    let worker: Worker | undefined
    const fail = (error: Error) => {
      if (active) setState({ request, error })
      active = false
      worker?.terminate()
    }
    try {
      if (typeof Worker === "undefined") throw new Error("Markdown worker is unavailable")
      worker = new Worker(new URL("./parse.worker.js", import.meta.url), { type: "module" })
      worker.onmessage = (event: MessageEvent<{ result?: ParsedMarkdown; error?: string }>) => {
        if (!active) return
        if (event.data.error || !event.data.result || event.data.result.kind !== kind) {
          fail(new Error(event.data.error || "Invalid Markdown worker response"))
          return
        }
        setState({ request, result: event.data.result })
        active = false
        worker?.terminate()
      }
      worker.onerror = (event) => {
        event.preventDefault()
        fail(new Error(event.message || "Markdown worker failed"))
      }
      worker.onmessageerror = () => fail(new Error("Markdown worker response could not be read"))
      worker.postMessage(request)
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
    return () => {
      active = false
      worker?.terminate()
    }
  }, [asynchronous, kind, request])

  const current = state?.request === request ? state : null
  return { asynchronous, result: synchronousResult ?? current?.result ?? null, error: current?.error }
}

/** Host adapters stay on the main thread, but long documents prepare them in yielding batches outside React render. */
export function useRenderedBlocks<T, R>(items: T[] | undefined, render: (item: T, index: number) => R, asynchronous: boolean, skip?: (node: R) => number) {
  const synchronous = useMemo(() => {
    if (asynchronous || !items) return null
    const nodes: R[] = []
    for (let index = 0; index < items.length;) {
      const node = render(items[index], index)
      nodes.push(node)
      index += 1 + (skip?.(node) ?? 0)
    }
    return nodes
  }, [asynchronous, items, render, skip])
  const [state, setState] = useState<{ items: T[]; render: typeof render; nodes?: R[]; error?: Error } | null>(null)

  useEffect(() => {
    if (!asynchronous || !items) {
      setState(null)
      return
    }
    let active = true
    let index = 0
    const nodes: R[] = []
    let timer: ReturnType<typeof setTimeout>
    const runBatch = () => {
      if (!active) return
      try {
        let processed = 0
        while (index < items.length && processed < 100) {
          const node = render(items[index], index)
          nodes.push(node)
          index += 1 + (skip?.(node) ?? 0)
          processed += 1
        }
        if (index < items.length) timer = setTimeout(runBatch, 0)
        else setState({ items, render, nodes })
      } catch (error) {
        if (active) setState({ items, render, error: error instanceof Error ? error : new Error(String(error)) })
      }
    }
    timer = setTimeout(runBatch, 0)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [asynchronous, items, render, skip])

  // A parent can recreate an adapter without changing the Markdown. Keep the current
  // document mounted while preparing its replacement, but never reuse another source's nodes.
  const current = state && state.items === items ? state : null
  const error = current?.render === render ? current.error : undefined
  return {
    nodes: synchronous ?? current?.nodes ?? null,
    error,
    pending: asynchronous && !error && (!current?.nodes || current.render !== render),
  }
}
