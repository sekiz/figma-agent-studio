import { copyFile, mkdir } from "node:fs/promises";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
await mkdir("dist", { recursive: true });

/** The Figma sandbox is a plain JS VM: one self-contained ES2017 file, no imports. */
const options = {
  entryPoints: ["src/code.ts"],
  bundle: true,
  format: "iife",
  target: "es2017",
  outfile: "dist/code.js",
  logLevel: "info",
};

await copyFile("src/ui.html", "dist/ui.html");
if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
