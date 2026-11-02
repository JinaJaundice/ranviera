import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./shared", import.meta.url)) },
  },
  test: {
    include: ["server/src/**/*.test.ts", "web/src/**/*.test.ts", "web/src/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["server/src/test-setup.ts"],
    // the Intel macOS runner of the release workflow takes several times longer than a laptop, and tests that finish in
    // a second here passed the default limit of 5 seconds there (2 November 2026)
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
