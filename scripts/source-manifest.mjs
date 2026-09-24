import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const inputs = ["bin", "src", "tests", "scripts", ".github", "package.json", "package-lock.json", "tsconfig.json", "tsup.config.ts", "README.md"];

function files(path) {
  const absolute = resolve(root, path);
  if (statSync(absolute).isDirectory()) return readdirSync(absolute).sort().flatMap((name) => files(join(path, name)));
  return [path];
}

export function sourceManifest() {
  const entries = inputs.flatMap(files).map((path) => {
    const data = readFileSync(resolve(root, path));
    return { path: relative(root, resolve(root, path)).replaceAll("\\", "/"), bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex") };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const sha256 = createHash("sha256").update(entries.map((entry) => `${entry.path}\0${entry.bytes}\0${entry.sha256}\n`).join("")).digest("hex");
  return { sha256, entries };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(sourceManifest(), null, 2)}\n`);
}
