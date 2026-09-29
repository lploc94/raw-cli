import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Copy the same standalone, unminified modules that the installed bundled
// plugins use. Forking an example never imports Raw's source checkout.
for (const name of ["read_file", "write_file", "bash", "view_image", "list_skills", "load_skill", "list_vars", "read_var", "todo"]) {
  const source = join("dist", "tools", "builtin", name);
  const target = join("examples", "tools", name);
  mkdirSync(target, { recursive: true });
  for (const file of ["tool.json", "index.mjs"]) copyFileSync(join(source, file), join(target, file));
}
