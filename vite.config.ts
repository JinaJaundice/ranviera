import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// The web app lives in web/. The server (server/src/main.ts) mounts Vite in
// middleware mode during development and serves dist/ in production, so the
// app and its API share port 5182.
export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./shared", import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
