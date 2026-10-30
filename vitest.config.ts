import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests live outside src/ so `npm run build`'s tsc pass (include: src/**)
// never needs vitest's types. Node 18+ provides WebCrypto globally, so the
// crypto modules run unmodified in the default node environment.
//
// The `obsidian` package is type-declarations only (no runtime JS), so any
// src module importing it resolves to the inert mock below when it runs
// under vitest.
export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
