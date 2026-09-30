import assert from "node:assert/strict";
import test from "node:test";
import { dashboardFixture } from "./fixtures/dashboard.js";
import type { SessionSummary } from "../src/sessions/store.js";
import type { CommandRecord } from "../src/processes/presentation.js";
import type { ProcessControl } from "../src/processes/controls.js";
import { openAiDone, openAiFrame } from "./fixtures/mock-provider.js";
async function settled(f: Awaited<ReturnType<typeof dashboardFixture>>, sid: string, pid: string, cid: string) {
  for (let n = 0; n < 500; n++) {
    const value = await f.json<ProcessControl>(`/sessions/${sid}/commands/${pid}/controls/${cid}`);
    if (value.state !== "running") return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("control did not finish");
}
test("Commands projects background output and audited Stop while a model lease is held", async () => {
  const f = await dashboardFixture({agent: {tools: {use: ["builtin/process"]}}});
  try {
    const s = await f.json<SessionSummary>("/sessions", "POST", {cwd:f.root,agent:"raw"});
    const store = f.server.context.store!;
    const process = await f.server.context.processes!.forSession(s.id).start({command:"printf '\\033[31mhello\\033[0m'; sleep 20",cwd:f.root});
    await new Promise(resolve => setTimeout(resolve, 300));
    const owner = store.claimSession(s.id);
    try {
      const rows = await f.json<{items:CommandRecord[]}>(`/sessions/${s.id}/commands`);
      assert.equal(rows.items[0]?.kind, "background");
      const page = await f.json<{chunks:Array<{text:string}>}>(`/sessions/${s.id}/commands/${process.id}/output`);
      assert.equal(page.chunks.map(c=>c.text).join(""), "hello");
      const body = {clientRequestId:"stop-one"};
      const a = await f.json<ProcessControl>(`/sessions/${s.id}/commands/${process.id}/stop`, "POST", body);
      const b = await f.json<ProcessControl>(`/sessions/${s.id}/commands/${process.id}/stop`, "POST", body);
      assert.equal(a.id,b.id);
      assert.equal((await settled(f,s.id,process.id,a.id)).state,"completed");
      assert.equal(store.getSessionHistory({sessionId:s.id}).items.length,0);
      assert.equal(store.sessionIsBusy(s.id),true);
    } finally {store.releaseSession(s.id,owner);}
  } finally {await f.close();}
});
test("Stop cannot bypass selected Process policy or cross session ownership",async()=>{
  const f=await dashboardFixture({agent:{tools:{use:["builtin/process"],rules:[{match:"builtin/process",effect:"deny"}]}}});
  try {
    const a=await f.json<SessionSummary>("/sessions","POST",{cwd:f.root,agent:"raw"});
    const b=await f.json<SessionSummary>("/sessions","POST",{cwd:f.root,agent:"raw"});
    const p=await f.server.context.processes!.forSession(a.id).start({command:"sleep 20",cwd:f.root});
    assert.equal((await f.api(`/sessions/${b.id}/commands/${p.id}/stop`,"POST",{clientRequestId:"wrong"})).status,404);
    const receipt=await f.json<ProcessControl>(`/sessions/${a.id}/commands/${p.id}/stop`,"POST",{clientRequestId:"denied"});
    const done=await settled(f,a.id,p.id,receipt.id);
    assert.equal(done.state,"failed"); assert.equal(done.result?.code,"tool_denied");
    assert.equal(f.server.context.processes!.forSession(a.id).status(p.id).state,"running");
  } finally {await f.close();}
});
test("foreground nonzero Bash is a failed durable command without changing batch transport",async()=>{
  const f=await dashboardFixture({agent:{tools:{use:["builtin/bash"]}},responses:[
    {frames:[openAiFrame({tool_calls:[{index:0,id:"shell",type:"function",function:{name:"bash",arguments:JSON.stringify({commands:[{command:"printf foreground; exit 3"}]})}}]},"tool_calls"),openAiDone]},
    {frames:[openAiFrame({content:"done"},"stop"),openAiDone]}]});
  try {
    const s=await f.json<SessionSummary>("/sessions","POST",{cwd:f.root,agent:"raw"});
    const op=await f.json<{id:string}>(`/sessions/${s.id}/operations`,"POST",{clientRequestId:"run",kind:"turn",agent:"raw",input:"go"});
    await f.wait(op.id);
    const rows=await f.json<{items:CommandRecord[]}>(`/sessions/${s.id}/commands`);
    assert.equal(rows.items.length,1);assert.equal(rows.items[0]?.state,"failed");assert.equal(rows.items[0]?.exitCode,3);
    const history=await f.json<{items:unknown[]}>(`/sessions/${s.id}/history`);
    assert.ok(JSON.stringify(history).includes('\\"status\\":\\"ok\\"')||JSON.stringify(history).includes('"status":"ok"'));
    const output=await f.json<{chunks:Array<{text:string}>}>(`/sessions/${s.id}/commands/${rows.items[0]!.id}/output`);
    assert.equal(output.chunks.map(c=>c.text).join(""),"foreground");
  } finally {await f.close();}
});

test("deleting a session forgets foreground rows and cannot resurrect them at shutdown",async()=>{
  const f=await dashboardFixture();
  try {
    const s=await f.json<SessionSummary>("/sessions","POST",{cwd:f.root,agent:"raw"});
    const commands=f.server.context.processes!.commands;
    const entry=commands.forSession(s.id).begin("printf old",f.root);entry.output("stdout","old");entry.finish({isError:false,content:[],exitCode:0});
    assert.equal(commands.list(s.id).length,1);
    await f.json(`/sessions/${s.id}`,"DELETE");
    assert.equal(commands.list(s.id).length,0);
    assert.doesNotThrow(()=>commands.close());
    assert.equal(f.server.context.store!.getSession(s.id),undefined);
  }finally{await f.close();}
});

test("foreground UI observer failures do not change Bash side effects or outcomes",async()=>{
  const {bashTool}=await import("../src/tools/primitives.js");
  for(const fail of ["begin","finish"]){
    const result=await bashTool({commands:[{command:"printf preserved; exit 7"}]},{cwd:process.cwd(),maxOutputBytes:4096,
      commandActivity:{begin(){if(fail==="begin")throw new Error("disk full");return {output(){throw new Error("output observer");},finish(){throw new Error("disk full");}}}}});
    const block=result.content.find(c=>c.type==="json");assert.ok(block);
    const rows=(block.value as {results:Array<{status:string;exit_code:number;stdout:string}>}).results;
    assert.equal(rows[0]?.status,"ok");assert.equal(rows[0]?.exit_code,7);assert.equal(rows[0]?.stdout,"preserved");
  }
});
