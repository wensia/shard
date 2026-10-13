import { StrictMode, useCallback, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import {
  MarkdownContent,
  MarkdownDocument,
  type MarkdownImageRenderProps,
} from "@shard/markdown"
import "@shard/markdown/styles.css"
import "../../../../vendor/kiln/tokens/colors.css"
import "../../../../vendor/kiln/tokens/dark.css"
import "./renderer.css"

/** One page shown by the native detail view. */
export interface RenderPayload {
  kind: "fragment" | "document"
  content: string
}

/** Messages posted to the native `shard` script message handler. */
type NativeMessage =
  | { type: "ready" }
  | { type: "rendered" }
  | { type: "error"; message: string }

declare global {
  interface Window {
    shardRender?: (payload: RenderPayload) => void
    webkit?: {
      messageHandlers?: {
        shard?: { postMessage: (message: NativeMessage) => void }
      }
    }
  }
}

function postToNative(message: NativeMessage) {
  window.webkit?.messageHandlers?.shard?.postMessage(message)
}

// Vault files are content-addressed under `assets/`; the native scheme
// handler serves them from the offline cache or fetches them on demand.
function vaultAssetURL(path: string) {
  const relative = path.replace(/^\.?\//, "")
  return `shard://vault/${relative.split("/").map(encodeURIComponent).join("/")}`
}

function VaultImage({ alt, path }: MarkdownImageRenderProps) {
  return <img className="shard-ios-image" alt={alt} src={vaultAssetURL(path)} loading="lazy" />
}

function syncTheme(query: MediaQueryList) {
  document.documentElement.dataset.theme = query.matches ? "dark" : "light"
}

function App() {
  const [payload, setPayload] = useState<RenderPayload | null>(null)
  const renderImage = useCallback((image: MarkdownImageRenderProps) => <VaultImage {...image} />, [])

  useEffect(() => {
    window.shardRender = (next) => setPayload(next)
    postToNative({ type: "ready" })
    return () => {
      window.shardRender = undefined
    }
  }, [])

  useEffect(() => {
    if (payload) postToNative({ type: "rendered" })
  }, [payload])

  if (!payload) return null
  return payload.kind === "fragment" ? (
    <MarkdownContent compactParagraphs className="shard-ios-body" content={payload.content} renderImage={renderImage} />
  ) : (
    <MarkdownDocument className="shard-ios-body" content={payload.content} />
  )
}

const scheme = window.matchMedia("(prefers-color-scheme: dark)")
syncTheme(scheme)
scheme.addEventListener("change", () => syncTheme(scheme))

window.addEventListener("error", (event) => postToNative({ type: "error", message: event.message }))

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
