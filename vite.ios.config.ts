import { defineConfig, mergeConfig } from "vite"
import base from "./vite.config"

// The iOS app packages the same entry, components and styles as the website.
export default mergeConfig(base, defineConfig({
  base: "./",
  build: {
    outDir: "apps/ios/Shard/Resources/WebApp",
    emptyOutDir: true,
    target: "safari17",
    assetsInlineLimit: 0,
  },
}))
