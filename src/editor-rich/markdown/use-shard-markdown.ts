import { useEffect, useMemo, useState } from "react"
import { ASYNC_MARKDOWN_THRESHOLD } from "@shard/markdown"
import { parseShardMarkdown, type ShardMarkdownDocument } from "./parse"

/** Cards use the editor's document model, with large parses kept off the UI thread. */
export function useShardMarkdown(content: string) {
  const asynchronous = content.length > ASYNC_MARKDOWN_THRESHOLD
  const immediate = useMemo(() => {
    if (asynchronous) return null
    try {
      return { result: parseShardMarkdown(content, { sourcePositions: true }) }
    } catch (error) {
      return { error: String(error) }
    }
  }, [content, asynchronous])
  const [state, setState] = useState<{ content: string; result?: ShardMarkdownDocument; error?: string }>()
  useEffect(() => {
    if (!asynchronous) return
    let active = true
    let worker: Worker | undefined
    const fail = (error: string) => {
      if (active) setState({ content, error })
      active = false
      worker?.terminate()
    }
    try {
      worker = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" })
      worker.onmessage = (event: MessageEvent<{ result?: ShardMarkdownDocument; error?: string }>) => {
        if (!active) return
        if (!event.data.result) return fail(event.data.error ?? "Markdown parse failed")
        setState({ content, result: event.data.result })
        active = false
        worker?.terminate()
      }
      worker.onerror = (event) => { event.preventDefault(); fail(event.message) }
      worker.onmessageerror = () => fail("Invalid Markdown worker response")
      worker.postMessage(content)
    } catch (error) {
      fail(String(error))
    }
    return () => { active = false; worker?.terminate() }
  }, [content, asynchronous])
  const current = state?.content === content ? state : undefined
  return { asynchronous, result: immediate?.result ?? current?.result, error: immediate?.error ?? (asynchronous ? current?.error : undefined) }
}
