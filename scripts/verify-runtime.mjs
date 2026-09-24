import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { sourceManifest } from "./source-manifest.mjs";

const major = Number(process.versions.node.split(".")[0]);
if (major !== 22 && major !== 24) throw new Error(`verify-runtime requires Node 22 or 24, got ${process.version}`);
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
const sourceBefore = sourceManifest().sha256;
const childNode = spawnSync("node", ["-p", "process.versions.node"], { env, encoding: "utf8" });
if (childNode.status !== 0 || Number(childNode.stdout.trim().split(".")[0]) !== major) {
  throw new Error(`child PATH uses a different Node: ${childNode.stdout || childNode.stderr}`);
}

const reports = [];
for (const args of [["run", "check"], ["run", "test:overhead"], ["run", "test:package"]]) {
  const result = spawnSync("npm", args, { env, cwd: process.cwd(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0 || result.error) {
    process.stderr.write(output);
    throw new Error(`npm ${args.join(" ")} failed on Node ${process.version}`);
  }
  const tests = Number(output.match(/(?:ℹ|#) tests (\d+)/)?.[1] ?? 0);
  const pass = Number(output.match(/(?:ℹ|#) pass (\d+)/)?.[1] ?? 0);
  if (args[1] !== "test:overhead" && (tests < 1 || pass < 1)) {
    throw new Error(`npm ${args.join(" ")} reported no passing tests: ${output.slice(-500)}`);
  }
  if (args[1] === "test:overhead" && (!/"promptTokens": 25/.test(output) || !/"combinedTokens": 175/.test(output))) {
    throw new Error("prompt overhead report is missing or changed");
  }
  reports.push({ command: `npm ${args.join(" ")}`, tests, pass });
}
const sourceAfter = sourceManifest().sha256;
if (sourceAfter !== sourceBefore) throw new Error("source/build inputs changed during runtime qualification");
process.stdout.write(`${JSON.stringify({ node: process.version, execPath: process.execPath,
  childNode: childNode.stdout.trim(), sourceSha256: sourceAfter, reports })}\n`);
