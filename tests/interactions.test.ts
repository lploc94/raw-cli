import assert from "node:assert/strict";
import test from "node:test";
import { prepareForm, canonicalInteractionResult, validateFormAnswers } from "../src/panels/forms.js";
import type { FormField } from "../src/panels/contract.js";
const fields: FormField[] = [
  { id: "text", label: "Text", kind: "text", required: true, max_bytes: 8192 },
  { id: "choices", label: "Choices", kind: "multi_select", required: true, min_selected: 1, max_selected: 2,
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
];
test("the shared oracle counts the complete escaped UTF-8 result and reduces published limits", () => {
  const prepared = prepareForm(fields, 8192);
  assert.equal(prepared.maxResultBytes, 8192);
  assert.ok((prepared.fields[0] as Extract<FormField, {kind:"text"}>).max_bytes! < 8192);
  const accepted = validateFormAnswers(prepared, { text: '雪\n"\\', choices: ["b", "a"] });
  const canonical = canonicalInteractionResult({ status: "answered", answers: accepted });
  assert.equal(new TextEncoder().encode(canonical).length, Buffer.byteLength(canonical));
  assert.deepEqual(JSON.parse(canonical).answers, { text: '雪\n"\\', choices: ["a", "b"] });
  assert.throws(() => prepareForm(fields, 8), /budget_too_small/);
});
test("validation rejects unknown fields/options, duplicates, required omissions and aggregate overflow", () => {
  const prepared = prepareForm(fields, 256);
  for (const answers of [{ text: "x", choices: ["bad"] }, { text: "x", choices: ["a", "a"] }, { text: "", choices: ["a"] },
    { text: "x" }, { text: "x", choices: ["a"], injected: "x" }]) assert.throws(() => validateFormAnswers(prepared, answers));
  const large = prepareForm(Array.from({length:8}, (_, i) => ({ id:`f${i}`, label:`F${i}`, kind:"text", required:true })), 512);
  const tooMuch = Object.fromEntries(large.fields.map(field => [field.id, '"'.repeat((field as Extract<FormField,{kind:"text"}>).max_bytes!)]));
  assert.throws(() => validateFormAnswers(large, tooMuch), /budget/);
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionStore } from "../src/sessions/store.js";
import type { InteractionRequest } from "../src/interactions/contract.js";
const declaration = { id:"input", title:"Input", icon:"panel", open:"never", context:"none", acp_plan:false,
  placement:"chat", actions:[] } as const;
function durableFixture() {
  const root = mkdtempSync(join(tmpdir(), "raw-interactions-"));
  const options = {env:{XDG_STATE_HOME:root,XDG_CONFIG_HOME:root}};
  const store = openSessionStore(options); const session = store.createSession({cwd:root,title:"input"});
  const owner = store.claimSession(session.id);
  const request: InteractionRequest = { identity:{requestId:"r",sessionId:session.id,runId:"run",toolCallId:"call",owner:"local/custom",panelId:"input"},
    declaration:{...declaration,actions:[]}, document:{blocks:[{id:"form",kind:"form",fields}]},formBlockId:"form",
    form:prepareForm(fields,8192),revision:1,state:"pending",createdAt:Date.now(),deadline:Date.now()+100000 };
  return {store,session,owner,request,options};
}
test("durable request and terminal result are atomic, idempotent and fenced across stores", () => {
  const f = durableFixture(); const other = openSessionStore(f.options);
  try {
    f.store.createInteraction(f.request,f.owner);
    assert.equal(f.store.getSessionHistory({sessionId:f.session.id}).items.at(-1)!.kind,"interaction_request");
    assert.equal(other.getInteraction(f.session.id,"r")?.state,"pending");
    assert.throws(()=>other.settleInteraction(f.session.id,"r",1,"answered",'{"status":"answered","answers":{"text":"x","choices":["bad"]}}'));
    assert.equal(other.getInteraction(f.session.id,"r")!.state,"pending");
    const canonical = canonicalInteractionResult({status:"answered",answers:{text:"yes",choices:["a"]}});
    const won = other.settleInteraction(f.session.id,"r",1,"answered",canonical,{key:"key",body:"exact"});
    assert.equal(won.acknowledgement.canonicalResult,canonical);
    assert.deepEqual(f.store.settleInteraction(f.session.id,"r",1,"answered",canonical,{key:"key",body:"exact"}),won);
    assert.throws(()=>f.store.settleInteraction(f.session.id,"r",1,"answered",canonical,{key:"key",body:"different"}),(error: unknown) => (error as {code?:string}).code === "interaction_conflict");
    assert.throws(()=>f.store.settleInteraction(f.session.id,"r",1,"cancelled",undefined,{key:"other",body:"other"}),(error: unknown) => (error as {code?:string}).code === "interaction_conflict");
    assert.equal(f.store.getSessionHistory({sessionId:f.session.id}).items.filter(item=>item.kind==="interaction_response").length,1);
    f.store.releaseSession(f.session.id,f.owner);
    assert.equal(f.store.recoverInteractions(),0);
    assert.equal(other.getInteraction(f.session.id,"r")!.canonicalResult,canonical);
    f.store.deleteSession(f.session.id);
    assert.equal(other.getInteraction(f.session.id,"r"),undefined);
  } finally {other.close();f.store.close();}
});
test("owner loss interrupts pending requests without reviving a tool or losing accepted answers", () => {
  const f = durableFixture();
  try {
    f.store.createInteraction(f.request,f.owner);
    f.store.releaseSession(f.session.id,f.owner);
    assert.equal(f.store.recoverInteractions(),1);
    assert.equal(f.store.getInteraction(f.session.id,"r")?.state,"interrupted");
    assert.equal(f.store.recoverInteractions(),0);
    assert.throws(()=>f.store.settleInteraction(f.session.id,"r",1,"answered","{}"),(error: unknown) => (error as {code?:string}).code === "interaction_conflict");
  } finally {f.store.close();}
});

import { InteractionService } from "../src/interactions/service.js";
const input = {panel:"input",document:{blocks:[{id:"form",kind:"form",fields}]} };
const responseDeclaration = {...declaration,actions:[{id:"submit",label:"Submit",kind:"response",scope:"block",blocks:["form"],response:"submit"},
  {id:"cancel",label:"Cancel",kind:"response",scope:"block",blocks:["form"],response:"cancel"}]} as const;
test("the generic service persists before publishing, validates without settling, and accepts once while busy", async () => {
  const f = durableFixture(); const published: InteractionRequest[] = [];
  const service = new InteractionService({store:f.store,available:true,publish:request=>{
    assert.ok(f.store.getInteraction(f.session.id,request.identity.requestId)); published.push(request);
  }});
  const binding = {identity:f.request.identity,owner:f.owner,maxOutputBytes:8192,
    prepare:()=>({declaration:{...responseDeclaration,actions:[...responseDeclaration.actions].map(action=>({...action,blocks:[...action.blocks]}))}}), publish:async()=>{}};
  try {
    const waiting = service.forCall(binding).request(input);
    await new Promise(resolve=>setImmediate(resolve));
    const pending = published[0]!;
    const id = pending.identity.requestId;
    assert.equal(f.store.sessionIsBusy(f.session.id),true);
    assert.throws(()=>service.respond(f.session.id,id,{requestId:id,expectedRevision:1,idempotencyKey:"bad",response:"submit",answers:{text:"x",choices:["wrong"]}}));
    assert.equal(f.store.getInteraction(f.session.id,id)!.state,"pending");
    const submit = {requestId:id,expectedRevision:1,idempotencyKey:"ok",response:"submit" as const,answers:{text:'雪"',choices:["b"]}};
    const ack = service.respond(f.session.id,id,submit);
    assert.deepEqual(service.respond(f.session.id,id,submit),ack);
    assert.deepEqual(await waiting,{status:"answered",answers:{text:'雪"',choices:["b"]}});
    assert.throws(()=>service.respond("foreign",id,submit));
    assert.throws(()=>service.respond(f.session.id,id,{...submit,idempotencyKey:"race"}));
  } finally {service.close();f.store.close();}
});
test("unavailable, unrepresentable, abort and deadline paths do not leave a live waiter", async () => {
  const base = {identity:{runId:"run",toolCallId:"call",owner:"local/custom",panelId:"input"},maxOutputBytes:8192,
    prepare:()=>({declaration:{...responseDeclaration,actions:responseDeclaration.actions.map(action=>({...action,blocks:[...action.blocks]}))}}), publish:async()=>{}};
  const unavailable = new InteractionService();
  await assert.rejects(unavailable.forCall(base).request(input),error=>(error as {code:string}).code==="interaction_unavailable");
  const seen: InteractionRequest[] = []; const service = new InteractionService({available:true,publish:request=>seen.push(request)});
  try {
    await assert.rejects(service.forCall({...base,maxOutputBytes:8}).request(input),/budget_too_small/);
    assert.equal(seen.length,0);
    const controller = new AbortController();
    const aborted = service.forCall({...base,signal:controller.signal}).request(input);
    await new Promise(resolve=>setImmediate(resolve)); controller.abort();
    assert.equal((await aborted).status,"cancelled");
    assert.equal((await service.forCall(base).request({...input,timeout_ms:5})).status,"expired");
  } finally {service.close();unavailable.close();}
});

test("stable field IDs include prototype names and inherited values cannot satisfy a field", () => {
  const form = prepareForm([{id:"__proto__",label:"Proto",kind:"text",required:true},{id:"constructor",label:"Constructor",kind:"text",required:true}],8192);
  const answers = validateFormAnswers(form,JSON.parse('{"__proto__":"safe","constructor":"stable"}'));
  assert.deepEqual(JSON.parse(canonicalInteractionResult({status:"answered",answers})).answers,JSON.parse('{"__proto__":"safe","constructor":"stable"}'));
  assert.throws(()=>validateFormAnswers(form,Object.create({__proto__:"safe",constructor:"inherited"})));
});
test("owner loss is fenced inside the response transaction, even before a recovery scan", () => {
  const f=durableFixture();
  try{
    f.store.createInteraction(f.request,f.owner);f.store.releaseSession(f.session.id,f.owner);
    assert.throws(()=>f.store.settleInteraction(f.session.id,"r",1,"answered","{}",{key:"late",body:"late"}),
      error=>(error as {code:string}).code==="interaction_conflict");
    assert.equal(f.store.getInteraction(f.session.id,"r")!.state,"pending");
    assert.equal(f.store.recoverInteractions(),1);
  }finally{f.store.close();}
});
test("response validation rejects aggregate escaped overflow and leaves a durable request pending", async()=>{
  const f=durableFixture();let request!:InteractionRequest;
  const service=new InteractionService({store:f.store,available:true,publish:value=>{request=value;}});
  const many=Array.from({length:8},(_,i)=>({id:`f${i}`,label:`F${i}`,kind:"text" as const,required:true}));
  const binding={identity:f.request.identity,owner:f.owner,maxOutputBytes:512,
    prepare:()=>({declaration:{...responseDeclaration,actions:responseDeclaration.actions.map(action=>({...action,blocks:[...action.blocks]}))}}),publish:async()=>{}};
  try{
    const pending=service.forCall(binding).request({panel:"input",document:{blocks:[{id:"form",kind:"form",fields:many}]}});
    await new Promise(resolve=>setImmediate(resolve));
    const answers=Object.fromEntries(request.form.fields.map(field=>[field.id,'"'.repeat((field as Extract<FormField,{kind:"text"}>).max_bytes!)]));
    assert.throws(()=>service.respond(f.session.id,request.identity.requestId,{requestId:request.identity.requestId,expectedRevision:1,idempotencyKey:"overflow",response:"submit",answers}),/budget/);
    assert.equal(f.store.getInteraction(f.session.id,request.identity.requestId)!.state,"pending");
    service.close();assert.equal((await pending).status,"interrupted");
  }finally{service.close();f.store.close();}
});

import { createAgent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ProviderAdapter } from "../src/llm/types.js";
test("an accepted answer survives a failed tool-result commit without fabricating a completed call",async()=>{
  const f=durableFixture();let acceptedId="";
  const service=new InteractionService({store:f.store,available:true,publish:request=>{
    if(request.state!=="pending")return;acceptedId=request.identity.requestId;
    queueMicrotask(()=>service.respond(f.session.id,acceptedId,{requestId:acceptedId,expectedRevision:1,idempotencyKey:"answer",response:"submit",answers:{text:'雪"',choices:["a"]}}));
  }});
  const registry=new ToolRegistry();
  registry.register({name:"custom",canonicalName:"local/custom",description:"custom",inputSchema:{type:"object"},
    panels:[{...responseDeclaration,actions:responseDeclaration.actions.map(action=>({...action,blocks:[...action.blocks]}))}],
    handler:async(_args,context)=>({isError:false,content:[{type:"json",value:await context.interactions!.request(input)}]})});
  const provider:ProviderAdapter={modelConfig:{agentName:"a",provider:"ollama",method:"openai-chat-completions",model:"fixture"},
    generate:async()=>({text:"",toolCalls:[{id:"call",name:"custom",arguments:{}}],finishReason:"tool_calls"})};
  const append=f.store.appendAgentMessage.bind(f.store);
  f.store.appendAgentMessage=(...args)=>{if(args[2].role==="tool")throw new Error("simulated commit failure");return append(...args);};
  const agent=createAgent({provider,registry,cwd:f.session.cwd,interactions:service,persistence:{store:f.store,sessionId:f.session.id,surface:"web",owner:f.owner,ownership:"host"}});
  try{
    const result=await agent.run("ask");assert.equal(result.code,"persistence_error");
    const saved=f.store.getInteraction(f.session.id,acceptedId)!;
    assert.equal(saved.state,"answered");assert.deepEqual(JSON.parse(saved.canonicalResult!).answers,{text:'雪"',choices:["a"]});
    assert.equal(agent.transcript.some(message=>message.role==="tool"),false);
    assert.equal(Number(f.store.database.prepare("SELECT count(*) AS n FROM session_tool_views").get()?.n),0);
    assert.equal(f.store.getSessionHistory({sessionId:f.session.id}).items.filter(item=>item.kind==="interaction_response").length,1);
  }finally{await agent.close();service.close();f.store.close();}
});

test("effective optional selection limits can reach zero without invalidating the declared document", async()=>{
  const service=new InteractionService({available:true});
  const optional:FormField[]=[{id:"optional",label:"Optional",kind:"multi_select",options:[{id:"a",label:"A"}]}];
  const limit=Buffer.byteLength(canonicalInteractionResult({status:"answered",answers:{}}));
  const pending=service.forCall({identity:{runId:"r",toolCallId:"c",owner:"local/custom",panelId:"input"},maxOutputBytes:limit,
    prepare:()=>({declaration:{...responseDeclaration,actions:responseDeclaration.actions.map(action=>({...action,blocks:[...action.blocks]}))}}),
    publish:async(_panel,document)=>{assert.equal((document.blocks[0] as {fields:FormField[]}).fields[0]!.kind,"multi_select");},
  }).request({panel:"input",document:{blocks:[{id:"form",kind:"form",fields:optional}]}});
  service.close();assert.equal((await pending).status,"interrupted");
});

test("abort and submission race settle once in either order and unawaited requests end with their call",async()=>{
  for(const abortFirst of [true,false]){
    const f=durableFixture();let value!:InteractionRequest;const controller=new AbortController();
    const service=new InteractionService({store:f.store,available:true,publish:request=>{value=request;}});
    try{
      const wait=service.forCall({identity:f.request.identity,owner:f.owner,maxOutputBytes:8192,signal:controller.signal,
        prepare:()=>({declaration:{...responseDeclaration,actions:responseDeclaration.actions.map(action=>({...action,blocks:[...action.blocks]}))}}),publish:async()=>{},
      }).request(input);
      await new Promise(resolve=>setImmediate(resolve));
      const submit=()=>service.respond(f.session.id,value.identity.requestId,{requestId:value.identity.requestId,expectedRevision:1,idempotencyKey:"race",response:"submit",answers:{text:"yes",choices:["a"]}});
      if(abortFirst){controller.abort();assert.throws(submit);}else{submit();controller.abort();}
      assert.equal((await wait).status,abortFirst?"cancelled":"answered");
      assert.equal(f.store.getSessionHistory({sessionId:f.session.id}).items.filter(item=>item.kind==="interaction_response").length,1);
      const unfinished=service.forCall({identity:f.request.identity,owner:f.owner,maxOutputBytes:8192,
        prepare:()=>({declaration:{...responseDeclaration,actions:responseDeclaration.actions.map(action=>({...action,blocks:[...action.blocks]}))}}),publish:async()=>{},
      }).request(input);
      service.endCall(f.request.identity.runId,f.request.identity.toolCallId);
      assert.equal((await unfinished).status,"cancelled");
    }finally{service.close();f.store.close();}
  }
});

test("in-memory lookups, submissions and retries require the exact stored session scope",async()=>{
  for(const sessionId of [undefined,"session-a"]){
    let request!:InteractionRequest;
    const service=new InteractionService({available:true,publish:value=>{request=value;}});
    try{
      const wait=service.forCall({identity:{runId:"r",toolCallId:"c",owner:"local/custom",panelId:"input",...(sessionId?{sessionId}:{})},maxOutputBytes:8192,
        prepare:()=>({declaration:{...responseDeclaration,actions:responseDeclaration.actions.map(action=>({...action,blocks:[...action.blocks]}))}}),publish:async()=>{},
      }).request(input);
      await new Promise(resolve=>setImmediate(resolve));
      const id=request.identity.requestId;
      const body={requestId:id,expectedRevision:1,idempotencyKey:"scoped",response:"submit" as const,answers:{text:"x",choices:["a"]}};
      for(const foreign of ["session-b",...(sessionId?[undefined]:[])]){
        assert.equal(service.get(foreign,id),undefined);
        assert.throws(()=>service.respond(foreign,id,body),error=>(error as {code:string}).code==="interaction_not_found");
      }
      const ack=service.respond(sessionId,id,body);assert.equal((await wait).status,"answered");
      assert.deepEqual(service.respond(sessionId,id,body),ack);
      assert.throws(()=>service.respond("session-b",id,body));
    }finally{service.close();}
  }
});
