import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The bundle is served to WKWebView through the app's `shard://` scheme, so
// asset URLs stay relative and the Markdown worker keeps its module path.
export default defineConfig({
  base: "./",
  plugins: [react()],
  optimizeDeps: {
    exclude: ["@shard/markdown"],
    include: ["react", "react/jsx-runtime"],
  },
  build: {
    outDir: fileURLToPath(new URL("../Shard/Resources/Renderer", import.meta.url)),
    emptyOutDir: true,
    target: "safari17",
    assetsInlineLimit: 0,
  },
})
