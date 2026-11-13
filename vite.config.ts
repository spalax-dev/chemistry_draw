import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [
    react(),
    nodePolyfills({
      globals: { process: true, Buffer: true, global: true },
    }),
  ],
  clearScreen: false,
  build: {
    rollupOptions: {
      external: ["raphael"],
      output: {
        globals: {
          raphael: "Raphael",
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    fs: { allow: ["."] },
  },
  resolve: {
    alias: {
      // Sanctioned third-party override (docs/architecture.md §5.7): Ketcher's
      // bundled `file-saver` save path must use the Tauri filesystem instead of
      // a browser download. The shim lives in `src/fileSaver.ts`.
      "file-saver": path.resolve(__dirname, "src/fileSaver.ts"),
    },
  },
}));
