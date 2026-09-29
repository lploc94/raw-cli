import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

for (const name of ["read_file", "write_file", "bash", "view_image", "list_skills", "load_skill", "list_vars", "read_var", "todo"]) {
  const destination = join("dist", "tools", "builtin", name);
  mkdirSync(destination, { recursive: true });
  copyFileSync(join("src", "tools", "bundled", name, "tool.json"), join(destination, "tool.json"));
}
