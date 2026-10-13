import esbuild from "esbuild";

const prod = process.argv.includes("production");

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2022",
  outfile: "main.js",
  platform: "browser",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  // Drop only console.debug in production (dev-logging) builds; console.error
  // stays so genuine failures (e.g. corrupted settings) still surface.
  pure: prod ? ["console.debug"] : [],
  logLevel: "info",
});

if (process.argv.includes("--watch")) {
  await ctx.watch();
  console.log("Watching for changes...");
} else if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
  console.log("Watching for changes...");
}
