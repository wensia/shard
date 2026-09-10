import { readFile } from "node:fs/promises"
import { createServer as createNetServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createServer } from "vite"

// Keep Vite outside Playwright's loader so Node loads React/Babel dependencies.
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url))
const livePreviewPath = path.join(projectRoot, "src/editor/extensions/live-preview.ts")
const harnessPath = path.join(projectRoot, "__shard-preview-hmr-harness.tsx")
const legacyPreview = await readFile(new URL("./legacy-preview.ts", import.meta.url), "utf8")
const harness = await readFile(new URL("./harness.tsx", import.meta.url), "utf8")
let useLegacyPreview = true

// Vite treats port 0 as its default port, so reserve an ephemeral port first.
const reservation = createNetServer()
await new Promise((resolve, reject) => {
  reservation.once("error", reject)
  reservation.listen(0, "127.0.0.1", resolve)
})
const { port } = reservation.address()
await new Promise((resolve) => reservation.close(resolve))

const server = await createServer({
  root: projectRoot,
  configFile: path.join(projectRoot, "vite.config.ts"),
  // React excludes node_modules from transforms, including prebundled React.
  cacheDir: path.join(process.argv[2], "node_modules/.vite"),
  server: {
    host: "127.0.0.1", port, strictPort: true,
    hmr: { host: "127.0.0.1", port },
  },
  plugins: [{
    name: "shard-preview-hmr-test",
    enforce: "pre",
    resolveId(id) { if (id === "/__shard-preview-hmr-harness.tsx") return harnessPath },
    load(id) { if (id === harnessPath) return harness },
    transform(code, id) {
      if (id.split("?")[0] === livePreviewPath && useLegacyPreview) {
        return { code: legacyPreview, map: null }
      }
      return code
    },
    configureServer(vite) {
      vite.middlewares.use("/__shard-preview-hmr.html", async (_request, response, next) => {
        try {
          const html = await vite.transformIndexHtml("/__shard-preview-hmr.html", `
            <!doctype html><html><head><meta charset="UTF-8"></head>
            <body><main id="root" style="margin:40px; width:640px"></main>
            <script type="module" src="/__shard-preview-hmr-harness.tsx"></script></body></html>`)
          response.setHeader("Content-Type", "text/html")
          response.end(html)
        } catch (error) { next(error) }
      })
    },
  }],
})

let closing = false
async function close() {
  if (closing) return
  closing = true
  await server.close()
  process.exit(0)
}
process.on("SIGTERM", close)
process.on("disconnect", close)
process.on("message", (message) => {
  if (message.type === "update") {
    useLegacyPreview = false
    // Notify only this server; never write production source files.
    server.watcher.emit("change", livePreviewPath)
  } else if (message.type === "close") {
    void close()
  }
})
await server.listen()
process.send({ type: "ready", url: `http://127.0.0.1:${port}/__shard-preview-hmr.html` })
