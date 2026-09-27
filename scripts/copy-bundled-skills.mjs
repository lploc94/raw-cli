import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

for (const id of ["configure_raw", "create_skill", "create_tool", "create_hook", "create_agent", "add_mcp", "create_package"]) {
  const source = join("src", "skills", "bundled", id);
  for (const destination of [join("dist", "skills", "builtin", id), join("examples", "skills", id)]) {
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
}
