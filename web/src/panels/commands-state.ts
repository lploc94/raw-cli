import type { CommandRecord } from "../../../src/processes/presentation.js";
import type { PanelStackItem } from "../../../src/panels/stack.js";
export const COMMANDS_ID = "__commands";
export const commandRunning = (item: CommandRecord) => ["starting", "running", "stopping"].includes(item.state);
/** A local layout descriptor only: never submitted to PanelHost or exposed as tool authority. */
export function commandsSection(commands: readonly CommandRecord[]): PanelStackItem {
  const revision = commands.reduce((max, item) => Math.max(max, item.updatedAt), 0);
  return { panel: COMMANDS_ID, owner: "", title: "Commands", icon: "activity", revision, updatedAt: revision || null, closed: false, stale: false,
    declaration: { id: COMMANDS_ID, title: "Commands", icon: "activity", open: "never", context: "none", acp_plan: false, actions: [] },
    document: commands.length ? { blocks: [], summary: `${commands.filter(commandRunning).length} running · ${commands.length} total` } : null };
}
/** Strip OSC (including hyperlinks), CSI and remaining terminal controls; never interpret terminal markup as HTML. */
export function terminalText(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-_]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
