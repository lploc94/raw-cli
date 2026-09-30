import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, openChat } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";
import { AxeBuilder } from "@axe-core/playwright";
test.use({scenario:{agent:{tools:{use:["local/input"]}},responses:[
  {frames:[openAiFrame({tool_calls:[{index:0,id:"call",type:"function",function:{name:"input",arguments:"{}"}}]},"tool_calls"),openAiDone]},
  {frames:[openAiFrame({content:"received"},"stop"),openAiDone]}]}});
for (const placement of ["chat","sidebar"]) test(`${placement} form survives reload, preserves its draft on validation and becomes read-only`,async({page,raw})=>{
  const folder=join(raw.env.XDG_CONFIG_HOME!,"raw","tools","input");mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,"tool.json"),JSON.stringify({api_version:2,id:"input",version:"1.0.0",name:"input",description:"Input",entry:"./index.mjs",
    input_schema:{type:"object",properties:{},additionalProperties:false},panels:[{id:"input",title:"Input",placement,actions:[
      {id:"submit",label:"Send answer",kind:"response",scope:"block",response:"submit",blocks:["form"]},
      {id:"cancel",label:"Cancel question",kind:"response",scope:"block",response:"cancel",blocks:["form"]}]}]}));
  writeFileSync(join(folder,"index.mjs"),`export async function handler(args,context){const result=await context.interactions.request({panel:'input',document:{blocks:[
    {id:'form',kind:'form',fields:[{id:'text',label:'Your answer',kind:'text',required:true},{id:'choice',label:'Choose',kind:'single_select',required:true,options:[{id:'yes',label:'Yes'},{id:'no',label:'No'}]}]}]}});return{content:[{type:'json',value:result}]};}`);
  await openChat(page,raw);
  await page.getByRole("textbox",{name:"Message"}).fill("ask");await page.getByRole("button",{name:"Send",exact:true}).click();
  if(placement==="sidebar") await page.getByRole("button",{name:"Open question",exact:true}).click();
  await expect(page.getByRole("textbox",{name:"Your answer",exact:true})).toBeVisible();
  await page.reload();
  if(placement==="sidebar") await page.getByRole("button",{name:"Open question",exact:true}).click();
  const form=page.locator('[data-kind="form"]');
  await expect(form).toHaveCount(1);
  await page.getByRole("textbox",{name:"Your answer",exact:true}).fill('雪"');
  await page.getByRole("button",{name:"Send answer",exact:true}).click();
  await expect(page.getByRole("textbox",{name:"Your answer",exact:true})).toHaveValue('雪"');
  await expect(form.getByRole("alert")).toContainText("required");
  await page.getByRole("combobox",{name:"Choose",exact:true}).selectOption("yes");
  expect((await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa"]).analyze()).violations).toEqual([]);
  const responseRoute="**/api/sessions/*/interactions/*/responses";
  await page.route(responseRoute,async route=>{
    const body=route.request().postDataJSON();
    await route.continue({postData:JSON.stringify({...body,answers:{...body.answers,choice:"invalid"}})});
  });
  await page.getByRole("button",{name:"Send answer",exact:true}).click();
  await expect(form.getByRole("alert")).toContainText("unknown option");
  await expect(page.getByRole("textbox",{name:"Your answer",exact:true})).toHaveValue('雪"');
  await page.unroute(responseRoute);
  await page.getByRole("button",{name:"Send answer",exact:true}).click();
  await expect(page.getByTestId("assistant-message")).toContainText("received");
  await expect(page.getByRole("textbox",{name:"Your answer",exact:true})).toBeDisabled();
  await page.reload();
  if(placement==="sidebar") await page.getByRole("button",{name:"Open panel",exact:true}).click();
  await expect(page.getByRole("textbox",{name:"Your answer",exact:true})).toHaveValue('雪"');
  await expect(page.getByRole("textbox",{name:"Your answer",exact:true})).toBeDisabled();
  expect(raw.provider.requests).toHaveLength(2);
});

test("a display-only form has an unavailable notice and no active response controls",async({page,raw})=>{
  const folder=join(raw.env.XDG_CONFIG_HOME!,"raw","tools","input");mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,"tool.json"),JSON.stringify({api_version:2,id:"input",version:"1.0.0",name:"input",description:"Input",entry:"./index.mjs",
    input_schema:{type:"object",properties:{},additionalProperties:false},panels:[{id:"input",title:"Input",placement:"chat",actions:[
      {id:"submit",label:"Send answer",kind:"response",scope:"block",response:"submit",blocks:["form"]}]}]}));
  writeFileSync(join(folder,"index.mjs"),`export async function handler(args,context){await context.panels.update('input',{op:'replace',document:{blocks:[
    {id:'form',kind:'form',fields:[{id:'text',label:'Display field',kind:'text'}]}]}});return{content:[]};}`);
  await openChat(page,raw);await page.getByRole("textbox",{name:"Message"}).fill("show");await page.getByRole("button",{name:"Send",exact:true}).click();
  await expect(page.getByText("Responses are unavailable for this form.")).toBeVisible();
  await expect(page.getByRole("textbox",{name:"Display field"})).toBeDisabled();
  await expect(page.getByRole("button",{name:"Send answer",exact:true})).toHaveCount(0);
});

test("a valid prototype-name field preserves typed text and delivers its stable ID",async({page,raw})=>{
  const folder=join(raw.env.XDG_CONFIG_HOME!,"raw","tools","input");mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,"tool.json"),JSON.stringify({api_version:2,id:"input",version:"1.0.0",name:"input",description:"Input",entry:"./index.mjs",
    input_schema:{type:"object",properties:{},additionalProperties:false},panels:[{id:"input",title:"Input",placement:"chat",actions:[
      {id:"submit",label:"Send answer",kind:"response",scope:"block",response:"submit",blocks:["form"]},
      {id:"cancel",label:"Cancel question",kind:"response",scope:"block",response:"cancel",blocks:["form"]}]}]}));
  writeFileSync(join(folder,"index.mjs"),`export async function handler(args,context){const result=await context.interactions.request({panel:'input',document:{blocks:[
    {id:'form',kind:'form',fields:[{id:'__proto__',label:'Stable field',kind:'text',required:true}]}]}});return{content:[{type:'json',value:result}]};}`);
  await openChat(page,raw);await page.getByRole("textbox",{name:"Message"}).fill("ask");await page.getByRole("button",{name:"Send",exact:true}).click();
  await page.getByRole("textbox",{name:"Stable field",exact:true}).fill("preserved");
  await expect(page.getByRole("textbox",{name:"Stable field",exact:true})).toHaveValue("preserved");
  await page.getByRole("button",{name:"Send answer",exact:true}).click();
  await expect(page.getByTestId("assistant-message")).toContainText("received");
  expect(JSON.stringify(raw.provider.requests.at(-1)!.body)).toContain("__proto__");
  await expect(page.getByRole("textbox",{name:"Stable field",exact:true})).toHaveValue("preserved");
});

test.describe("subsequent sidebar questions",()=>{
  test.use({scenario:{agent:{tools:{use:["local/input"]}},responses:[
    {frames:[openAiFrame({tool_calls:[{index:0,id:"first",type:"function",function:{name:"input",arguments:'{"label":"First answer"}'}}]},"tool_calls"),openAiDone]},
    {frames:[openAiFrame({content:"first received"},"stop"),openAiDone]},
    {frames:[openAiFrame({tool_calls:[{index:0,id:"second",type:"function",function:{name:"input",arguments:'{"label":"Next answer"}'}}]},"tool_calls"),openAiDone]},
    {frames:[openAiFrame({content:"next received"},"stop"),openAiDone]}]}});
  test("reload then answer then another question binds the sidebar to the new request",async({page,raw})=>{
    const folder=join(raw.env.XDG_CONFIG_HOME!,"raw","tools","input");mkdirSync(folder,{recursive:true});
    writeFileSync(join(folder,"tool.json"),JSON.stringify({api_version:2,id:"input",version:"1.0.0",name:"input",description:"Input",entry:"./index.mjs",
      input_schema:{type:"object",properties:{label:{type:"string"}},required:["label"],additionalProperties:false},panels:[{id:"input",title:"Input",placement:"sidebar",actions:[
        {id:"submit",label:"Send answer",kind:"response",scope:"block",response:"submit",blocks:["form"]},
        {id:"cancel",label:"Cancel question",kind:"response",scope:"block",response:"cancel",blocks:["form"]}]}]}));
    writeFileSync(join(folder,"index.mjs"),`export async function handler(args,context){const result=await context.interactions.request({panel:'input',document:{blocks:[
      {id:'form',kind:'form',fields:[{id:'text',label:args.label,kind:'text',required:true}]}]}});return{content:[{type:'json',value:result}]};}`);
    await openChat(page,raw);await page.getByRole("textbox",{name:"Message"}).fill("first");await page.getByRole("button",{name:"Send",exact:true}).click();
    await page.getByRole("button",{name:"Open question",exact:true}).click();
    await expect(page.getByRole("textbox",{name:"First answer",exact:true})).toBeVisible();
    await page.reload();await page.getByRole("button",{name:"Open question",exact:true}).click();
    await page.getByRole("textbox",{name:"First answer",exact:true}).fill("one");
    await page.getByRole("button",{name:"Send answer",exact:true}).click();
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await page.getByRole("textbox",{name:"Message"}).fill("next");await page.getByRole("button",{name:"Send",exact:true}).click();
    await expect(page.getByRole("textbox",{name:"Next answer",exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"Send answer",exact:true})).toBeEnabled();
    await page.getByRole("textbox",{name:"Next answer",exact:true}).fill("two");
    await page.getByRole("button",{name:"Send answer",exact:true}).click();
    await expect(page.getByTestId("assistant-message")).toHaveCount(2);
    await expect(page.locator(".interaction-receipt").first()).toContainText("one");
    await expect(page.locator(".interaction-receipt").last()).toContainText("two");
    await expect(page.getByRole("textbox",{name:"Next answer",exact:true})).toHaveValue("two");
    expect(raw.provider.requests).toHaveLength(4);
  });
});

test("omitted optional prototype fields do not become inherited answers in sidebar history",async({page,raw})=>{
  const folder=join(raw.env.XDG_CONFIG_HOME!,"raw","tools","input");mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,"tool.json"),JSON.stringify({api_version:2,id:"input",version:"1.0.0",name:"input",description:"Input",entry:"./index.mjs",
    input_schema:{type:"object",properties:{},additionalProperties:false},panels:[{id:"input",title:"Input",placement:"sidebar",actions:[
      {id:"submit",label:"Send answer",kind:"response",scope:"block",response:"submit",blocks:["form"]},
      {id:"cancel",label:"Cancel question",kind:"response",scope:"block",response:"cancel",blocks:["form"]}]}]}));
  writeFileSync(join(folder,"index.mjs"),`export async function handler(args,context){const result=await context.interactions.request({panel:'input',document:{blocks:[
    {id:'form',kind:'form',fields:[{id:'normal',label:'Required answer',kind:'text',required:true},{id:'__proto__',label:'Optional note',kind:'text'}]}]}});return{content:[{type:'json',value:result}]};}`);
  await openChat(page,raw);await page.getByRole("textbox",{name:"Message"}).fill("ask");await page.getByRole("button",{name:"Send",exact:true}).click();
  await page.getByRole("button",{name:"Open question",exact:true}).click();
  await page.getByRole("textbox",{name:"Required answer",exact:true}).fill("kept");
  await page.getByRole("button",{name:"Send answer",exact:true}).click();
  await expect(page.getByTestId("assistant-message")).toContainText("received");
  await expect(page.locator(".interaction-receipt")).toContainText("kept");
  await expect(page.locator(".interaction-receipt")).not.toContainText("Optional note");
  await page.reload();
  await expect(page.locator(".interaction-receipt")).toContainText("kept");
  await expect(page.getByTestId("assistant-message")).toContainText("received");
});

import { openSessionStore } from "../../src/sessions/store.js";
import { prepareForm } from "../../src/panels/forms.js";
import type { InteractionRequest } from "../../src/interactions/contract.js";
test("a foreign pending question mounts the sidebar form without a reload or ordinary panel commit",async({page,raw})=>{
  const folder=join(raw.env.XDG_CONFIG_HOME!,"raw","tools","input");mkdirSync(folder,{recursive:true});
  const actions=[{id:"submit",label:"Send answer",kind:"response" as const,scope:"block" as const,response:"submit" as const,blocks:["form"]},
    {id:"cancel",label:"Cancel question",kind:"response" as const,scope:"block" as const,response:"cancel" as const,blocks:["form"]}];
  writeFileSync(join(folder,"tool.json"),JSON.stringify({api_version:2,id:"input",version:"1.0.0",name:"input",description:"Input",entry:"./index.mjs",
    input_schema:{type:"object",properties:{},additionalProperties:false},panels:[{id:"input",title:"Input",placement:"sidebar",actions}]}));
  writeFileSync(join(folder,"index.mjs"),'export async function handler(){return{content:[]};}');
  await openChat(page,raw);
  const id=new URL(page.url()).pathname.split("/").at(-1)!;
  const store=openSessionStore({env:raw.env});const owner=store.claimSession(id);
  try{
    const fields=[{id:"answer",label:"Foreign answer",kind:"text" as const,required:true}];
    const request:InteractionRequest={identity:{requestId:"foreign-ui",sessionId:id,runId:"run",toolCallId:"call",owner:"local/input",panelId:"input"},
      declaration:{id:"input",title:"Input",icon:"panel",open:"never",context:"none",acp_plan:false,placement:"sidebar",actions},
      document:{blocks:[{id:"form",kind:"form",fields}]},formBlockId:"form",form:prepareForm(fields,8192),revision:1,state:"pending",createdAt:Date.now(),deadline:Date.now()+100000};
    store.createInteraction(request,owner);
    await page.getByRole("button",{name:"Open question",exact:true}).click();
    await expect(page.getByRole("textbox",{name:"Foreign answer",exact:true})).toBeVisible();
    assertNoOrdinaryCommit();
    await page.getByRole("textbox",{name:"Foreign answer",exact:true}).fill("foreign accepted");
    await page.getByRole("button",{name:"Send answer",exact:true}).click();
    await expect(page.getByRole("textbox",{name:"Foreign answer",exact:true})).toBeDisabled();
    await expect(page.locator(".interaction-receipt")).toContainText("foreign accepted");
    assertNoOrdinaryCommit();expect(raw.provider.requests).toHaveLength(0);
    function assertNoOrdinaryCommit(){expect(store.listSessionPanels(id)).toEqual([]);}
  }finally{store.releaseSession(id,owner);store.close();}
});

test("a delayed first acknowledgement cannot disable or overwrite the next sidebar question",async({page,raw})=>{
  const folder=join(raw.env.XDG_CONFIG_HOME!,"raw","tools","input");mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,"tool.json"),JSON.stringify({api_version:2,id:"input",version:"1.0.0",name:"input",description:"Input",entry:"./index.mjs",
    input_schema:{type:"object",properties:{},additionalProperties:false},panels:[{id:"input",title:"Input",placement:"sidebar",actions:[
      {id:"submit",label:"Send answer",kind:"response",scope:"block",response:"submit",blocks:["form"]},
      {id:"cancel",label:"Cancel question",kind:"response",scope:"block",response:"cancel",blocks:["form"]}]}]}));
  writeFileSync(join(folder,"index.mjs"),`export async function handler(args,context){const results=[];for(const label of ['First answer','Next answer'])results.push(await context.interactions.request({panel:'input',document:{blocks:[
    {id:'form',kind:'form',fields:[{id:'text',label,kind:'text',required:true}]}]}}));return{content:[{type:'json',value:results}]};}`);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let held=false;
  await page.route("**/api/sessions/*/interactions/*/responses",async route=>{
    const response=await route.fetch();if(!held){held=true;await gate;}await route.fulfill({response});
  });
  try{
    await openChat(page,raw);await page.getByRole("textbox",{name:"Message"}).fill("ask");await page.getByRole("button",{name:"Send",exact:true}).click();
    await page.getByRole("button",{name:"Open question",exact:true}).click();
    await page.getByRole("textbox",{name:"First answer",exact:true}).fill("one");
    const acknowledgement=page.waitForResponse(response=>response.url().endsWith("/responses")&&response.request().postDataJSON()?.answers?.text==="one");
    await page.getByRole("button",{name:"Send answer",exact:true}).click();
    await expect(page.getByRole("textbox",{name:"Next answer",exact:true})).toBeEnabled();
    await page.getByRole("textbox",{name:"Next answer",exact:true}).fill("two");
    release();await acknowledgement;
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    await expect(page.getByRole("textbox",{name:"Next answer",exact:true})).toHaveValue("two");
    await expect(page.getByRole("button",{name:"Send answer",exact:true})).toBeEnabled();
    await page.getByRole("button",{name:"Send answer",exact:true}).click();
    await expect(page.getByTestId("assistant-message")).toContainText("received");
    expect(raw.provider.requests).toHaveLength(2);
  }finally{release();}
});
