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
    const process = await f.server.context.processes!.forSession(s.id).start({command:"printf '\\033[31mhello\\033[0m'; sleep 0.1; printf 'é' >&2; sleep 20",cwd:f.root});
    // Wait for both writes; Git Bash on Windows takes longer than 300 ms to start.
    for (let n = 0; n < 200 && f.server.context.processes!.forSession(s.id).output(process.id).cursor < 16; n++) await new Promise(resolve => setTimeout(resolve, 50));
    const owner = store.claimSession(s.id);
    try {
      const rows = await f.json<{items:CommandRecord[]}>(`/sessions/${s.id}/commands`);
      assert.equal(rows.items[0]?.kind, "background");
      const page = await f.json<{chunks:Array<{channel:string;start:number;end:number;text:string}>;cursor:number;nextCursor:number}>(`/sessions/${s.id}/commands/${process.id}/output`);
      assert.equal(page.chunks.map(c=>c.text).join(""), "helloé");
      // Offsets count the unsanitized bytes: 14 for the colored hello, 2 for é.
      assert.deepEqual(page.chunks.map(c=>[c.channel,c.start,c.end]), [["stdout",0,14],["stderr",14,16]]);
      assert.deepEqual([page.cursor,page.nextCursor],[16,16]);
      assert.deepEqual((await f.json<{chunks:unknown[];nextCursor:number}>(`/sessions/${s.id}/commands/${process.id}/output?cursor=14`)).chunks,[{channel:"stderr",start:14,end:16,text:"é"}]);
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
test("foreground nonzero Bash is a failed durable command while the model result stays a reported exit",async()=>{
  const f=await dashboardFixture({agent:{tools:{use:["builtin/bash"]}},responses:[
    {frames:[openAiFrame({tool_calls:[{index:0,id:"shell",type:"function",function:{name:"bash",arguments:JSON.stringify({command:"printf foreground; exit 3"})}}]},"tool_calls"),openAiDone]},
    {frames:[openAiFrame({content:"done"},"stop"),openAiDone]}]});
  try {
    const s=await f.json<SessionSummary>("/sessions","POST",{cwd:f.root,agent:"raw"});
    const op=await f.json<{id:string}>(`/sessions/${s.id}/operations`,"POST",{clientRequestId:"run",kind:"turn",agent:"raw",input:"go"});
    await f.wait(op.id);
    const rows=await f.json<{items:CommandRecord[]}>(`/sessions/${s.id}/commands`);
    assert.equal(rows.items.length,1);assert.equal(rows.items[0]?.state,"failed");assert.equal(rows.items[0]?.exitCode,3);
    const history=await f.json<{items:Array<{toolResult?:{code?:string;host?:{status?:string;exitCode?:number|null};segments:Array<{text:string}>}}>}>(`/sessions/${s.id}/history`);
    const result=history.items.find(item=>item.toolResult)?.toolResult;
    assert.equal(result?.code,undefined);assert.equal(result?.host?.status,"ok");assert.equal(result?.host?.exitCode,3);
    assert.match(result!.segments.map(segment=>segment.text).join("\n"),/\[exit 3 · /);
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
    const result=await bashTool({command:"printf preserved; exit 7"},{cwd:process.cwd(),maxOutputBytes:4096,
      commandActivity:{begin(){if(fail==="begin")throw new Error("disk full");return {output(){throw new Error("output observer");},finish(){throw new Error("disk full");}}}}});
    assert.equal(result.isError,false);assert.equal(result.host?.exitCode,7);
    assert.match(result.content.map(c=>c.type==="text"?c.text:"").join(""),/^preserved\n?\[exit 7 · /);
  }
});

test("foreground rows carry the call's description, call id and saved full output, and the listing counts the older rows it cuts",async()=>{
  const f=await dashboardFixture({agent:{tools:{use:["builtin/bash"]}},responses:[
    {frames:[openAiFrame({tool_calls:[{index:0,id:"long-call",type:"function",function:{name:"bash",arguments:JSON.stringify({command:"seq 1 200000",description:"Count a lot"})}}]},"tool_calls"),openAiDone]},
    {frames:[openAiFrame({tool_calls:[{index:0,id:"short-call",type:"function",function:{name:"bash",arguments:JSON.stringify({command:"printf short"})}}]},"tool_calls"),openAiDone]},
    {frames:[openAiFrame({content:"done"},"stop"),openAiDone]}]});
  try {
    const s=await f.json<SessionSummary>("/sessions","POST",{cwd:f.root,agent:"raw"});
    const op=await f.json<{id:string}>(`/sessions/${s.id}/operations`,"POST",{clientRequestId:"run",kind:"turn",agent:"raw",input:"go"});
    await f.wait(op.id);
    const rows=await f.json<{items:CommandRecord[];omitted?:number}>(`/sessions/${s.id}/commands`);
    assert.equal(rows.omitted,undefined);
    const [short,long]=rows.items;
    assert.deepEqual([long?.label,long?.toolCallId,long?.state],["Count a lot","long-call","exited"]);
    assert.match(long!.fullOutputPath!,/\S/,"the spilled output's path is on the row");
    assert.deepEqual([short?.label,short?.toolCallId,short?.fullOutputPath],[undefined,"short-call",undefined]);
  } finally {await f.close();}
  const {Commands}=await import("../src/processes/presentation.js");
  const records=(count:number)=>Array.from({length:count},(_,i)=>({id:`p${i}`,sessionId:"s",command:`job ${i}`,cwd:"/w",state:"exited" as const,createdAt:i,updatedAt:i,cursor:0,droppedBytes:0,earliestCursor:0,hostToken:"h",generation:0}));
  for(const [count,omitted] of [[132,0],[133,1],[200,68]] as const){
    const commands=new Commands({hostToken:"h",list:()=>records(count) as never,output:()=>{throw new Error("unused");}});
    const listing=commands.listing("s");
    assert.equal(listing.items.length,132);assert.equal(listing.omitted,omitted);
    assert.equal(listing.items[0]?.command,`job ${count-1}`,"newest first");
  }
});

test("foreground rows carry the last three non-empty output lines, sanitized and bounded, refreshed as output arrives; background rows never do", async () => {
  const {Commands}=await import("../src/processes/presentation.js");
  const job={id:"bg",sessionId:"s",command:"sleep 60",cwd:"/w",state:"running" as const,createdAt:1,updatedAt:1,cursor:9,droppedBytes:0,earliestCursor:0,hostToken:"h",generation:0};
  const commands=new Commands({hostToken:"h",list:()=>[job] as never,output:()=>{throw new Error("unused");}});
  const run=commands.forSession("s").begin("make all","/w",{label:"Build"});
  const row=()=>commands.list("s").find(item=>item.kind==="foreground")!;
  const settle=()=>new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(row().tail,undefined,"no tail before any output");
  run.output("stdout","line 1\nline 2\n\n   \n");
  await settle();
  assert.deepEqual(row().tail,[{channel:"stdout",text:"line 1"},{channel:"stdout",text:"line 2"}]);
  // A line split across chunks is joined; control sequences go; a carriage return keeps what follows it; channels are kept.
  run.output("stdout","line 3 is spl");
  run.output("stdout","it\n\x1b[31merror\x1b[0m-free 50%\r100%\n");
  run.output("stderr","\x1b]8;;https://x\x07fatal: boom\x1b]8;;\x07\n");
  await settle();
  assert.deepEqual(row().tail,[{channel:"stdout",text:"line 3 is split"},{channel:"stdout",text:"100%"},{channel:"stderr",text:"fatal: boom"}]);
  // A long line is cut to 160 bytes on a character boundary and the whole tail stays within 512 bytes.
  run.output("stdout",`${"é".repeat(400)}\n${"x".repeat(300)}\n${"y".repeat(300)}`);
  run.finish({isError:true,content:[],exitCode:1});
  const tail=row().tail!;
  assert.equal(tail.length,3);
  assert.ok(tail.every(line=>Buffer.byteLength(line.text)<=160&&!line.text.includes("�")));
  assert.ok(tail.reduce((sum,line)=>sum+Buffer.byteLength(line.text),0)<=512);
  assert.equal(tail[2]!.text,"y".repeat(160));
  assert.equal(row().state,"failed");
  const background=commands.list("s").find(item=>item.kind==="background")!;
  assert.equal(background.id,"bg");
  assert.equal("tail" in background,false);
});

test("the tail reads past trailing blank lines and long lines, and a carriage return hides what came before it", async () => {
  const {commandTail}=await import("../src/processes/presentation.js");
  const chunk=(text:string,channel:"stdout"|"stderr"="stdout")=>({channel,start:0,end:0,text});
  assert.deepEqual(commandTail([chunk("one\ntwo\nthree\n"),chunk("\n".repeat(20000)),chunk("   \n\t\n")]).map(line=>line.text),["one","two","three"]);
  const long=commandTail([chunk("before\n"),chunk(`${"z".repeat(20000)}\n`)]);
  assert.deepEqual(long.map(line=>line.text),["before","z".repeat(160)]);
  // Blank after the last carriage return: nothing is shown for that line, not the text it overwrote.
  assert.deepEqual(commandTail([chunk("kept\nold\r   \n")]).map(line=>line.text),["kept"]);
  // CRLF endings are line endings, not overwrites; a trailing carriage return keeps the last progress state.
  assert.deepEqual(commandTail([chunk("a\r\nb\r\n10%\r55%\r")]).map(line=>line.text),["a","b","55%"]);
  // The channel of a line is the channel of its last non-empty piece.
  assert.deepEqual(commandTail([chunk("warn: ","stderr"),chunk("x\n","stdout"),chunk("e\n","stderr")]),[{channel:"stdout",text:"warn: x"},{channel:"stderr",text:"e"}]);
  assert.deepEqual(commandTail([]),[]);
});

test("CLI task rows: an unchanged snapshot of many ended tasks writes nothing again, a changed task writes once", async () => {
  const {Commands}=await import("../src/processes/presentation.js");
  for(const count of [100,101,250]){
    let writes=0;
    const commands=new Commands({hostToken:"h",list:()=>[],output:()=>{throw new Error("unused");},publish:()=>{writes++;}});
    const tasks=Array.from({length:count},(_,i)=>({id:`t${i}`,name:`job ${i}`,type:"shell",state:"completed" as const,canStop:true,startedAt:i+1,endedAt:i+2,exitCode:0}));
    const snapshot=()=>{const rows=commands.cli("s","/w","cli/codex");for(const task of tasks)rows.upsert(task);};
    snapshot();
    assert.equal(writes,count,"each new task is written once");
    snapshot();snapshot();
    assert.equal(writes,count,`an unchanged snapshot of ${count} ended tasks writes nothing`);
    tasks[0]={...tasks[0]!,state:"failed" as never,exitCode:1};
    snapshot();
    assert.equal(writes,count+1,"the one changed task is written");
    // Another session's task with the same id is its own row.
    commands.cli("other","/w","cli/codex").upsert(tasks[1]!);
    assert.equal(writes,count+2);
  }
});
