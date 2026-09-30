import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openAiDone, openAiFrame } from "./mock-provider.js";

export const workflowAnswer = 'Đã chọn 雪 "once"';
export const workflowSource = "flowchart LR\n  Answer --> Process\n  Process --> Patch";
export const workflowPatch = "*** Begin Patch\n*** Add File: workflow.txt\n+written exactly once 雪\n*** End Patch";
export const workflowCall = (id: string, name: string, args: unknown) => ({ frames: [openAiFrame({ tool_calls: [
  { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
] }, "tool_calls"), openAiDone] });
export const workflowScenario = {
  agent: { request_timeout_ms: 60000, tools: { use: ["builtin/ask_user", "builtin/process", "builtin/write_file", "builtin/todo", "local/diagram"] } },
  responses: [
    workflowCall("ask", "ask_user", { questions: [{ id: "choice", label: "Workflow answer", kind: "text" }] }),
    workflowCall("todo-before", "todo", { todos: [{ id: "workflow", content: "Finish integrated workflow", status: "in_progress" }] }),
    workflowCall("start", "process", { action: "start", command: "printf 'workflow ready\\n'; sleep 60", label: "Workflow job" }),
    { frames: [openAiFrame({ content: "First turn complete." }, "stop"), openAiDone] },
    workflowCall("patch", "write_file", { patch: workflowPatch }),
    workflowCall("diagram", "diagram", { title: "Workflow diagram", source: workflowSource }),
    workflowCall("todo-after", "todo", { mode: "merge", todos: [{ id: "workflow", status: "done" }] }),
    { frames: [openAiFrame({ content: "Patched.\n\n```mermaid\n" + workflowSource + "\n```\n" }, "stop"), openAiDone] },
    { hold: true },
  ],
};
export function installWorkflowDiagram(env: NodeJS.ProcessEnv) {
  const destination = join(env.XDG_CONFIG_HOME!, "raw", "tools", "diagram");
  mkdirSync(destination, { recursive: true });
  cpSync(join(process.cwd(), "examples", "tools", "diagram"), destination, { recursive: true });
}
