const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { detached: true, stdio: ["ignore", 1, 2] });
child.unref();
writeFileSync(process.argv[2], String(child.pid));
setTimeout(() => {}, 5000);
