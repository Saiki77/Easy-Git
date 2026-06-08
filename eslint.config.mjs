import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: ["main.js", "node_modules/**", "*.mjs"],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      // Over-eager: lowercases proper nouns ("Easy Git" → "easy Git",
      // "GitHub" → "github") and isn't enforced by the official plugin
      // validator. We keep intentional Title Case on buttons/status.
      "obsidianmd/ui/sentence-case": "off",
      // We log only on genuine errors (corrupted data.json) and behind the
      // user-controlled `debugLogging` setting — both are intentional and
      // gated, which is exactly what the guideline permits.
      "obsidianmd/rule-custom-message": "off",
    },
  },
]);
