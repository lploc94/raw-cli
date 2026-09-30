// Crash qualification runs the built host, with no test-only application hooks.
import { startDashboard } from "../../dist/index.js";
const [cwd, configPath] = process.argv.slice(2);
const server = await startDashboard({ port: 0, cwd, configPath });
process.send({ url: server.url, token: server.token });
