import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dashboardFixture, eventStream } from "./fixtures/dashboard.js";
import { openAiFrame, openAiDone } from "./fixtures/mock-provider.js";
import type { InteractionRequest, InteractionRequestView } from "../src/interactions/contract.js";
import type { SessionOperation } from "../src/sessions/operations.js";
import type { SessionSummary } from "../src/sessions/store.js";
async function fixture(placement = "sidebar") {
  const f = await dashboardFixture({agent:{tools:{use:["local/input"]}},responses:[
    {frames:[openAiFrame({tool_calls:[{index:0,id:"call",type:"function",function:{name:"input",arguments:"{}"}}]},"tool_calls"),openAiDone]},
    {frames:[openAiFrame({content:"received"},"stop"),openAiDone]}]});
  const folder = join(f.env.XDG_CONFIG_HOME!,"raw","tools","input");mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,"tool.json"),JSON.stringify({api_version:2,id:"input",version:"1.0.0",name:"input",description:"Input",
    input_schema:{type:"object",properties:{},additionalProperties:false},entry:"./index.mjs",panels:[{id:"input",title:"Input",placement,
      actions:[{id:"submit",label:"Submit",scope:"block",kind:"response",response:"submit",blocks:["form"]},
      {id:"cancel",label:"Cancel",scope:"block",kind:"response",response:"cancel",blocks:["form"]}]}]}));
  writeFileSync(join(folder,"index.mjs"),`export async function handler(args,context) {
    const result=await context.interactions.request({panel:'input',document:{blocks:[{id:'form',kind:'form',fields:[
      {id:'text',label:'Your answer',kind:'text',required:true},{id:'choice',label:'Choose',kind:'single_select',required:true,options:[{id:'yes',label:'Yes'},{id:'no',label:'No'}]}]}]}});
    return {content:[{type:'json',value:result}]};
  }`);
  const session=await f.json<SessionSummary>("/sessions","POST",{cwd:f.root,agent:"raw"});
  const operation=await f.json<SessionOperation>(`/sessions/${session.id}/operations`,"POST",{clientRequestId:"start",kind:"turn",agent:"raw",input:"ask"});
  let request:InteractionRequest|undefined;
  for(let i=0;i<200;i++){request=(await f.json<{interactions?:InteractionRequest[]}>(`/sessions/${session.id}`)).interactions?.[0];if(request)break;await new Promise(resolve=>setTimeout(resolve,10));}
  return {f,session,operation,request};
}
test("a non-Ask sidebar form accepts one response during the active turn and deduplicates retries",async()=>{
  const {f,session,operation,request}=await fixture();
  try {
    assert.ok(request,"pending request is published while the tool waits");
    const path=`/sessions/${session.id}/interactions/${request.identity.requestId}`;
    assert.equal((await f.json<SessionOperation>(`/operations/${operation.id}`)).state,"running");
    assert.equal((await f.json<InteractionRequest>(path)).state,"pending");
    const body={requestId:request.identity.requestId,expectedRevision:1,idempotencyKey:"answer",response:"submit",answers:{text:'雪\n"',choice:"yes"}};
    assert.equal((await f.api(`${path}/responses`,"POST",{...body,answers:{text:"x",choice:"bad"}})).status,422);
    assert.equal((await f.json<InteractionRequest>(path)).state,"pending");
    const [first,second]=await Promise.all([f.api(`${path}/responses`,"POST",body),f.api(`${path}/responses`,"POST",{...body,idempotencyKey:"race"})]);
    assert.deepEqual([first.status,second.status].sort(),[200,409]);
    const winner=first.status===200?body:{...body,idempotencyKey:"race"};
    const ack=await(first.status===200?first:second).json();
    assert.deepEqual(await f.json(`${path}/responses`,"POST",winner),ack);
    assert.equal((await f.api(`${path}/responses`,"POST",{...winner,answers:{text:"changed",choice:"yes"}})).status,409);
    assert.equal((await f.wait(operation.id)).state,"completed");
    const providerBody=JSON.stringify(f.provider.requests.at(-1)!.body);
    assert.match(providerBody,/answered/);assert.match(providerBody,/雪/);
    assert.equal(f.provider.requests.length,2);
    f.config.agents.raw.tools.use = [];
    writeFileSync(f.configPath,JSON.stringify(f.config));
    const historical = await f.json<InteractionRequestView>(path);
    assert.equal(historical.presentation.stale,true);
    assert.equal(historical.canonicalResult,(ack as {canonicalResult:string}).canonicalResult);
    assert.deepEqual(await f.json(`${path}/responses`,"POST",winner),ack);

    const foreign=await f.json<SessionSummary>("/sessions","POST",{cwd:f.root,agent:"raw"});
    assert.equal((await f.api(`/sessions/${foreign.id}/interactions/${request.identity.requestId}/responses`,"POST",body)).status,404);
  }finally{await f.close();}
});
test("abort cancels the durable question while its ordinary tool view rolls back",async()=>{
  const {f,session,operation,request}=await fixture("chat");
  try{
    assert.ok(request);
    await f.json(`/operations/${operation.id}/cancel`,"POST",{});
    assert.equal((await f.wait(operation.id)).state,"cancelled");
    const saved=await f.json<InteractionRequest>(`/sessions/${session.id}/interactions/${request.identity.requestId}`);
    assert.equal(saved.state,"cancelled");
    assert.equal((await f.api(`/sessions/${session.id}/views/${request.identity.viewInstanceId}`)).status,404);
  }finally{await f.close();}
});

import { openSessionStore } from "../src/sessions/store.js";
import { prepareForm, canonicalInteractionResult } from "../src/panels/forms.js";
test("a dashboard opened before a foreign request recovers owner loss on its next snapshot",async()=>{
  const f=await dashboardFixture();const other=openSessionStore({env:f.env});
  try{
    const session=other.createSession({cwd:f.root,title:"foreign"});const owner=other.claimSession(session.id);
    const fields=[{id:"answer",label:"Answer",kind:"text" as const,required:true}];
    const request:InteractionRequest={identity:{requestId:"foreign",sessionId:session.id,runId:"run",toolCallId:"call",owner:"local/input",panelId:"input"},
      declaration:{id:"input",title:"Input",icon:"panel",open:"never",context:"none",acp_plan:false,actions:[]},
      document:{blocks:[{id:"form",kind:"form",fields}]},formBlockId:"form",form:prepareForm(fields,8192),revision:1,state:"pending",createdAt:Date.now(),deadline:Date.now()+100000};
    other.createInteraction(request,owner);
    assert.equal((await f.json<{interactions:InteractionRequest[]}>(`/sessions/${session.id}`)).interactions[0]!.state,"pending");
    other.releaseSession(session.id,owner);
    assert.deepEqual((await f.json<{interactions:InteractionRequest[]}>(`/sessions/${session.id}`)).interactions,[]);
    assert.equal(other.getInteraction(session.id,"foreign")!.state,"interrupted");
    assert.equal(other.getInteraction(session.id,"foreign")!.canonicalResult,canonicalInteractionResult({status:"interrupted"}));
  }finally{other.close();await f.close();}
});

test("foreign question audits reconcile pending and terminal state on an already connected stream",async()=>{
  const f=await dashboardFixture();const other=openSessionStore({env:f.env});let stream:Awaited<ReturnType<typeof eventStream>>|undefined;
  try{
    const session=other.createSession({cwd:f.root,title:"foreign stream"});const owner=other.claimSession(session.id);
    stream=await eventStream(f.server,session.id);await stream.next();
    const fields=[{id:"answer",label:"Answer",kind:"text" as const,required:true}];
    const request:InteractionRequest={identity:{requestId:"foreign-stream",sessionId:session.id,runId:"run",toolCallId:"call",owner:"local/input",panelId:"input"},
      declaration:{id:"input",title:"Input",icon:"panel",open:"never",context:"none",acp_plan:false,actions:[]},
      document:{blocks:[{id:"form",kind:"form",fields}]},formBlockId:"form",form:prepareForm(fields,8192),revision:1,state:"pending",createdAt:Date.now(),deadline:Date.now()+100000};
    other.createInteraction(request,owner);
    let frame;do{frame=await stream.next();}while(frame.type!=="interaction");
    assert.equal(frame.data.state,"pending");
    const canonical=canonicalInteractionResult({status:"answered",answers:{answer:"Foreign answer"}});
    other.settleInteraction(session.id,"foreign-stream",1,"answered",canonical,{key:"foreign",body:"foreign"});
    do{frame=await stream.next();}while(frame.type!=="interaction");
    assert.equal(frame.data.state,"answered");assert.equal(frame.data.canonicalResult,canonical);
    assert.deepEqual(other.listOperations(session.id),[]);
    other.releaseSession(session.id,owner);
  }finally{stream?.close();other.close();await f.close();}
});
