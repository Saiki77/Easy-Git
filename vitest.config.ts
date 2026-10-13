import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "test/stubs/obsidian.ts"),
    },
  },
});
