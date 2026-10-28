import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@figma-studio/shared-types": pkg("shared-types"),
      "@figma-studio/surface-engine": pkg("surface-engine"),
      "@figma-studio/rtl-engine": pkg("rtl-engine"),
      "@figma-studio/ds-sentinel": pkg("ds-sentinel"),
      "@figma-studio/devspec": pkg("devspec"),
      "@figma-studio/bridge-server": pkg("bridge-server"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
