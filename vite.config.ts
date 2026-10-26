import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const host = process.env.TAURI_DEV_HOST;
// 网页版开发：把 /api 转给本机的 shard-server（同源，Cookie 才能用）。例如 SHARD_SERVER_URL=http://127.0.0.1:8787
const shardServer = process.env.SHARD_SERVER_URL;
const rootDir = path.dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    proxy: shardServer
      ? {
          "/api": { target: shardServer, changeOrigin: false },
          "/healthz": { target: shardServer, changeOrigin: false },
        }
      : undefined,
    watch: {
      // 3. ignore backend sources and Playwright evidence written during UI runs
      ignored: [
        "**/src-tauri/**",
        "**/tests/evidence/**",
        "**/docs/design/evidence/**",
      ],
    },
  },
});
