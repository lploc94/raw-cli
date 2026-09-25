import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

for (const id of ["configure_raw"]) {
  const source = join("src", "skills", "bundled", id);
  for (const destination of [join("dist", "skills", "builtin", id), join("examples", "skills", id)]) {
    mkdirSync(destination, { recursive: true });
    for (const filename of ["skill.json", "SKILL.md"]) copyFileSync(join(source, filename), join(destination, filename));
  }
}
