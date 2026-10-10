import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ToolRegistry } from "../src/tools/registry.js";
import { loadBundledTools } from "../src/tools/plugins/loader.js";
import { createAgent } from "../src/agent.js";
import { createProvider } from "../src/llm/client.js";
import { startMockProvider,openAiFrame,openAiDone } from "./fixtures/mock-provider.js";
import type { InteractionAdapter } from "../src/interactions/contract.js";
import { canonicalInteractionResult } from "../src/panels/forms.js";
const questions=[
  {id:"text",label:"Describe",kind:"text",multiline:true},
  {id:"choices",label:"Select",kind:"multi_select",options:[{id:"a",label:"A"},{id:"b",label:"B"}],min_selected:1,max_selected:2,free_text:{id:"extra",label:"Other detail"}},
  {id:"single",label:"Pick",kind:"single_select",options:[{id:"yes",label:"Yes"},{id:"no",label:"No"}]},
];
async function registry(rules:ConstructorParameters<typeof ToolRegistry>[0]=[]){
  const result=new ToolRegistry(rules);for(const tool of await loadBundledTools(["ask_user"]))result.register(tool);return result;
}
test("packaged Ask delivers every accepted ID and escaped Unicode byte through the real provider at the default budget",async()=>{
  const tools=await registry();
  const text='雪\n"\t\\'.repeat(80);const extra="Additional 雪 detail";
  const fixture=await startMockProvider([
    {frames:[openAiFrame({tool_calls:[{index:0,id:"ask",type:"function",function:{name:"ask_user",arguments:JSON.stringify({title:"Choices",questions})}}]},"tool_calls"),openAiDone]},
    {frames:[openAiFrame({content:"received"},"stop"),openAiDone]},
  ]);
  let requested=0;
  const interactionAdapter:InteractionAdapter=async request=>{
    requested++;assert.equal(request.form.maxResultBytes,65536);
    assert.ok((request.form.fields[0] as {max_bytes:number}).max_bytes<65536);
    assert.equal(request.declaration.placement,"chat");
    return {requestId:request.identity.requestId,expectedRevision:request.revision,idempotencyKey:randomUUID(),response:"submit",answers:{text,choices:["b","a"],extra,single:"no"}};
  };
  const agent=createAgent({registry:tools,provider:createProvider({agentName:"fixture",provider:"openai",method:"openai-chat-completions",model:"fixture",baseUrl:fixture.url,apiKey:"fixture"}),interactionAdapter});
  try{
    assert.equal((await agent.run("ask")).status,"completed");assert.equal(requested,1);
    const expected={status:"answered" as const,answers:{text,choices:["a","b"],extra,single:"no"}};
    const payload=fixture.requests[1]!.body as {messages:Array<{role:string;content:string}>};
    const tool=payload.messages.find(message=>message.role==="tool")!;
    assert.deepEqual(JSON.parse(tool.content),expected);
    const result=agent.transcript.find(message=>message.role==="tool")!;
    assert.equal(result.result.truncated,false);assert.deepEqual(result.result.content,[{type:"json",value:expected}]);
    assert.equal(Buffer.byteLength(canonicalInteractionResult(expected))<=65536,true);
  }finally{await agent.close();await fixture.close();}
});
test("Ask validates the complete question batch before permission or request publication",async()=>{
  const tools=await registry([{match:"builtin/ask_user",effect:"ask"}]);let approvals=0;let requests=0;
  for(const args of [{questions:[]},{questions:[{id:"q",label:"Q",kind:"text",options:[]}]},
    {questions:[{id:"q",label:"Q",kind:"multi_select",options:[{id:"a",label:"A"},{id:"b",label:"B"}],min_selected:2,max_selected:1}]},
    {questions:[{id:"q",label:"Q",kind:"single_select",options:[{id:"a",label:"A"}],free_text:{id:"same",label:"Other"}},{id:"same",label:"Duplicate",kind:"text"}]},
  ]){
    const result=await tools.dispatch("ask_user",args,{cwd:process.cwd(),maxOutputBytes:8192,approve:()=>{approvals++;return true;},
      interactions:{request:async()=>{requests++;return {status:"cancelled"};}}});
    assert.equal(result.code,"invalid_arguments");
  }
  assert.equal(approvals,0);assert.equal(requests,0);
});
test("Ask reports unavailable surfaces and retains a single canonical terminal block",async()=>{
  const tools=await registry();
  const unavailable=await tools.dispatch("ask_user",{questions:[{id:"q",label:"Q",kind:"text"}]},{cwd:process.cwd(),maxOutputBytes:8192});
  assert.equal(unavailable.code,"interaction_unavailable");
  for(const status of ["cancelled","expired","interrupted"] as const){
    const result=await tools.dispatch("ask_user",{questions:[{id:"q",label:"Q",kind:"text"}]},{cwd:process.cwd(),maxOutputBytes:8192,interactions:{request:async()=>({status})}});
    assert.equal(result.isError,true);assert.equal(result.code,`interaction_${status}`);assert.deepEqual(result.content,[{type:"json",value:{status}}]);
  }
});

import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookDispatcher } from "../src/hooks/dispatcher.js";
import type { SelectedHook } from "../src/hooks/contract.js";
test("Ask keeps permission before publication and exposes only ordinary result data to hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-ask-hooks-"));
  const script = join(root, "hook.mjs"); const log = join(root, "events.jsonl");
  await writeFile(script, 'import {appendFileSync} from "node:fs";let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>appendFileSync(process.argv[2],input+"\\n"));');
  const hook: SelectedHook = { protocol_version: 2, id: "agent/audit", name: "audit", folder: root,
    command: process.execPath, args: [script, log], timeoutMs: 1000, events: [{ name: "PreToolUse" }, { name: "PostToolUse" }] };
  const tools = await registry([{ match: "builtin/ask_user", effect: "ask" }]);
  let steps = 0; const order: string[] = [];
  const agent = createAgent({ registry: tools, autoApprove: false, cwd: root, hooks: new HookDispatcher([hook]),
    provider: { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
      generate: async () => ++steps === 1 ? { text: "", finishReason: "tool_calls", toolCalls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ id: "q", label: "Q", kind: "text" }] } }] } : { text: "done", finishReason: "stop", toolCalls: [] } },
    approve: () => { order.push("approval"); return true; },
    interactionAdapter: async request => { order.push("question");
      const pre = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      assert.equal(pre.length, 1); assert.equal(pre[0].event, "PreToolUse");
      return { requestId: request.identity.requestId, expectedRevision: request.revision, idempotencyKey: randomUUID(), response: "submit", answers: { q: "accepted" } }; },
  });
  try {
    assert.equal((await agent.run("ask")).status, "completed"); assert.deepEqual(order, ["approval", "question"]);
    const entries = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(entries.length, 2); assert.equal(entries[1].event, "PostToolUse");
    assert.match(JSON.stringify(entries[1]), /accepted/);
    assert.doesNotMatch(JSON.stringify(entries), /requestId|viewInstanceId|formBlockId|canonicalResult/);
  } finally { await agent.close(); await rm(root, { recursive: true, force: true }); }
});
