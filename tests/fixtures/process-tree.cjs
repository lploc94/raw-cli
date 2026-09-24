const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const marker = process.argv[2];
const child = spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'escaped'), 1000)", marker], { stdio: "ignore" });
writeFileSync(marker + ".ready", String(child.pid));
setTimeout(() => writeFileSync(marker + ".parent", "escaped"), 1000);
