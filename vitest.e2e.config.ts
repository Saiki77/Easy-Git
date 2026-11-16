import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// End-to-end runs against a real Git host. Same layout as vitest.config.ts,
// but `obsidian` resolves to a shim with a real requestUrl. Opt-in only:
// npm test never picks these up. See tests/e2e/encryption-github.e2e.ts.
export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/e2e/obsidian-e2e.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
