import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { dashboardFixture } from "./fixtures/dashboard.js";
import type { SessionSummary } from "../src/sessions/store.js";
import type { Approval } from "../src/dashboard/approvals.js";
import type { ProcessControl } from "../src/processes/controls.js";

type Fixture = Awaited<ReturnType<typeof dashboardFixture>>;
async function poll<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let n = 0; n < 500; n++) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("control state did not converge");
}
async function setup(f: Fixture) {
  const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
  const job = await f.server.context.processes!.forSession(session.id).start({command: "sleep 30", cwd:f.root});
  return { session, job, url: `/sessions/${session.id}/commands/${job.id}` };
}
async function done(f: Fixture, url: string, receipt: ProcessControl) {
  return poll(() => f.json<ProcessControl>(`${url}/controls/${receipt.id}`), value => value.state !== "running");
}

test("audited Stop approval is bound to control identity and cannot steal a busy turn", async () => {
  const f = await dashboardFixture({agent:{tools:{use:["builtin/process"],rules:[{
    match:"builtin/process",effect:"ask",when:{source:"arguments",any:"action",regex:"^stop$"}
  }]}}});
  try {
    const {session,job,url} = await setup(f);
    const store = f.server.context.store!;
    const lease = store.claimSession(session.id);
    try {
      const receipt = await f.json<ProcessControl>(`${url}/stop`,"POST",{clientRequestId:"needs-approval"});
      const pending = await poll(() => f.json<{approvals:Approval[]}>(`/sessions/${session.id}`), v => v.approvals.length > 0);
      const approval = pending.approvals[0]!;
      assert.equal(f.server.context.processes!.forSession(session.id).status(job.id).state,"running");
      assert.equal((await f.api(`/permissions/${approval.id}`,"POST",{operationId:"wrong",callId:approval.callId,allow:true})).status,409);
      await f.json(`/permissions/${approval.id}`,"POST",{operationId:approval.operationId,callId:approval.callId,allow:true});
      assert.equal((await done(f,url,receipt)).state,"completed");
      assert.equal(store.sessionIsBusy(session.id),true);
      assert.equal(store.getSessionHistory({sessionId:session.id}).items.length,0);
      assert.equal(f.provider.requests.length,0);
      assert.equal((await f.api(`/permissions/${approval.id}`,"POST",{operationId:approval.operationId,callId:approval.callId,allow:true})).status,409);
      const replay=await f.json<ProcessControl>(`${url}/stop`,"POST",{clientRequestId:"needs-approval"});
      assert.equal(replay.id,receipt.id);
    } finally { store.releaseSession(session.id,lease); }
  } finally { await f.close(); }
});

test("Process control invokes selected PreToolUse hook before permission or Stop",async()=>{
  const f=await dashboardFixture({agent:{tools:{use:["builtin/process"],rules:[{match:"builtin/process",effect:"ask"}]}}});
  try {
    const folder=join(dirname(f.configPath),"hooks","guard");mkdirSync(folder,{recursive:true});
    writeFileSync(join(folder,"hook.json"),JSON.stringify({protocol_version:2,name:"guard",command:"node",args:["./guard.mjs"],
      events:[{name:"PreToolUse",match:"builtin/process"}]}));
    writeFileSync(join(folder,"guard.mjs"),'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({decision:"deny",reason:"control guard"})));');
    (f.config.agents.raw as Record<string,unknown>).hooks={use:["agent/guard"]};writeFileSync(f.configPath,JSON.stringify(f.config));
    const {session,job,url}=await setup(f);
    const receipt=await f.json<ProcessControl>(`${url}/stop`,"POST",{clientRequestId:"hook-denied"});
    const result=await done(f,url,receipt);
    assert.equal(result.state,"failed");assert.equal(result.result?.code,"hook_denied",JSON.stringify(result));
    assert.equal(f.server.context.processes!.forSession(session.id).status(job.id).state,"running");
    const snapshot=await f.json<{approvals:Approval[]}>(`/sessions/${session.id}`);
    assert.equal(snapshot.approvals.length,0);assert.equal(f.provider.requests.length,0);
  } finally {await f.close();}
});

test("background output cannot bypass Process deselection or unconditional denial",async()=>{
  const f=await dashboardFixture({agent:{tools:{use:["builtin/process"],rules:[{match:"builtin/process",effect:"deny"}]}}});
  try {
    const {url}=await setup(f);
    const denied=await f.api(`${url}/output`);
    assert.equal(denied.ok,false);
    (f.config.agents.raw as Record<string,unknown>).tools={use:[]};writeFileSync(f.configPath,JSON.stringify(f.config));
    const deselected=await f.api(`${url}/output`);
    assert.equal(deselected.ok,false);
  } finally {await f.close();}
});

test("a pending control cannot use a saved agent changed during approval",async()=>{
  const f=await dashboardFixture({agent:{tools:{use:["builtin/process"],rules:[{match:"builtin/process",effect:"ask"}]}},extraAgents:{other:{model:"fixture",tools:{use:[]}}}});
  try {
    const {session,job,url}=await setup(f);
    const receipt=await f.json<ProcessControl>(`${url}/stop`,"POST",{clientRequestId:"stale"});
    const pending=await poll(()=>f.json<{approvals:Approval[]}>(`/sessions/${session.id}`),v=>v.approvals.length>0);
    const op=await f.json<{id:string}>(`/sessions/${session.id}/operations`,"POST",{clientRequestId:"switch",kind:"turn",agent:"other",input:"switch agent"});
    await f.wait(op.id);
    assert.equal(f.server.context.store!.getSession(session.id)?.agentName,"other");
    const approval=pending.approvals[0]!;
    await f.json(`/permissions/${approval.id}`,"POST",{operationId:approval.operationId,callId:approval.callId,allow:true});
    const result=await done(f,url,receipt);
    assert.equal(result.result?.code,"stale_agent");
    assert.equal(f.server.context.processes!.forSession(session.id).status(job.id).state,"running");
  }finally{await f.close();}
});

test("pending approval rechecks changed Process policy before executing Stop",async()=>{
  const f=await dashboardFixture({agent:{tools:{use:["builtin/process"],rules:[{match:"builtin/process",effect:"ask"}]}}});
  try {
    const {session,job,url}=await setup(f);
    const receipt=await f.json<ProcessControl>(`${url}/stop`,"POST",{clientRequestId:"policy-change"});
    const pending=await poll(()=>f.json<{approvals:Approval[]}>(`/sessions/${session.id}`),v=>v.approvals.length>0);
    (f.config.agents.raw as Record<string,unknown>).tools={use:["builtin/process"],rules:[{match:"builtin/process",effect:"deny"}]};writeFileSync(f.configPath,JSON.stringify(f.config));
    const approval=pending.approvals[0]!;
    await f.json(`/permissions/${approval.id}`,"POST",{operationId:approval.operationId,callId:approval.callId,allow:true});
    const result=await done(f,url,receipt);
    assert.equal(result.result?.code,"control_config_changed");
    assert.equal(f.server.context.processes!.forSession(session.id).status(job.id).state,"running");
  }finally{await f.close();}
});
