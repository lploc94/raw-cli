import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `tests/${name}`);

if (files.length === 0) {
  process.stderr.write("No test files found.\n");
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
}
