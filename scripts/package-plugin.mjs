// Packs the Figma plugin into a zip that designers import without building:
// unzip → Figma desktop → Plugins → Development → Import plugin from manifest…
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const plugin = join(root, "packages/figma-plugin");
for (const f of ["dist/code.js", "dist/ui.html", "manifest.json"]) {
  if (!existsSync(join(plugin, f))) throw new Error(`missing ${f}: run "pnpm build" first`);
}
const { version } = JSON.parse(readFileSync(join(root, "packages/mcp-server/package.json"), "utf8"));
const outDir = join(root, "release");
mkdirSync(outDir, { recursive: true });
const zip = join(outDir, `agent-studio-figma-plugin-${version}.zip`);
rmSync(zip, { force: true });
// Folder name inside the zip keeps the import path obvious: agent-studio-plugin/manifest.json
execFileSync("zip", ["-r", "-q", zip, "manifest.json", "dist", "README.md"], { cwd: plugin });
execFileSync("zip", ["-q", "-T", zip]);
console.log(zip);
