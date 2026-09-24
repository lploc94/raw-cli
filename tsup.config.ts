import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    platform: "node",
    target: "node22",
    outDir: "dist",
    clean: true,
    dts: true,
    splitting: false,
  },
  {
    entry: { raw: "bin/raw.ts" },
    format: ["esm"],
    platform: "node",
    target: "node22",
    outDir: "dist",
    clean: false,
    dts: false,
    splitting: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
