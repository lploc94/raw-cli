import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "tools/builtin/list_vars/index": "src/tools/bundled/list_vars/index.ts",
    "tools/builtin/read_var/index": "src/tools/bundled/read_var/index.ts",
    "tools/builtin/read_file/index": "src/tools/bundled/read_file/index.ts",
    "tools/builtin/write_file/index": "src/tools/bundled/write_file/index.ts",
    "tools/builtin/bash/index": "src/tools/bundled/bash/index.ts",
    "tools/builtin/view_image/index": "src/tools/bundled/view_image/index.ts",
    "tools/builtin/list_skills/index": "src/tools/bundled/list_skills/index.ts",
    "tools/builtin/load_skill/index": "src/tools/bundled/load_skill/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: false,
  dts: false,
  splitting: false,
  minify: false,
  external: ["node:sqlite"],
  outExtension: () => ({ js: ".mjs" }),
});
