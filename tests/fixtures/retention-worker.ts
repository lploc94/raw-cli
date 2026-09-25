import { loadConfig } from "../../src/config.js";
import { openSessionStore } from "../../src/sessions/store.js";

const [configPath, sessionId, timestamp] = process.argv.slice(2);
if (!configPath || !sessionId || !timestamp) throw new Error("missing retention worker arguments");
const runtime = await loadConfig({ flags: { configPath }, env: process.env, requireModel: true });
const store = openSessionStore({ env: process.env, now: () => Number(timestamp) });
try { process.stdout.write(JSON.stringify({ retentionDays: runtime.sessionsRetentionDays, visible: Boolean(store.getSession(sessionId)) })); }
finally { store.close(); }
