import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { SessionStore } from "../sessions/store.js";
import type { ToolResult } from "../tools/types.js";
import { utf8Prefix } from "../tools/results.js";
import type { CliTask } from "../backends/types.js";
import { LIVE_PROCESS_STATES, ProcessError, type ProcessOutput, type ProcessRecord, type ProcessChunk } from "./contract.js";
export interface CommandRecord {
  id: string; sessionId: string; kind: "foreground" | "background"; owner: "builtin/bash" | "builtin/powershell" | "builtin/process" | CliCommandOwner;
  command: string; commandTruncated?: boolean; cwd: string; label?: string; state: ProcessRecord["state"]; createdAt: number; updatedAt: number;
  endedAt?: number; exitCode?: number | null; signal?: string | null; error?: string; cursor: number; droppedBytes: number;
  /** Foreground Bash: the model's call id, and the complete output the call saved (docs/tool-ux-design.md §6.4). */
  toolCallId?: string; fullOutputPath?: string; fullOutputCapped?: boolean;
  /** Foreground Bash: the last non-empty output lines, sanitized and bounded (docs/dashboard-api.md). */
  tail?: CommandTailLine[];
  /** A backend CLI's task (`cli/*`): whether the CLI lets Raw stop it, and a pause it reported. */
  canStop?: boolean; paused?: boolean;
}
/** The CLI whose background task a row is (cli-background-work). */
export type CliCommandOwner = "cli/claude-code" | "cli/codex";
export interface CommandTailLine { channel: "stdout" | "stderr"; text: string }
const TAIL_LINES = 3, TAIL_LINE_BYTES = 160, TAIL_BYTES = 512;
/** The newest rows the dashboard shows; `omitted` counts the older ones that were cut. */
export const COMMAND_ROWS = 132;
export interface CommandListing { items: CommandRecord[]; omitted: number }
export interface CommandActivity {
  /** `label` is the call's description. */
  begin(command: string, cwd: string, call?: { label?: string; toolCallId?: string; owner?: "builtin/bash" | "builtin/powershell" }): { output(channel: "stdout" | "stderr", text: string): void; finish(result: ToolResult): void };
}
export function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
export function presentProcess(record: ProcessRecord): CommandRecord {
  const {id,sessionId,command,cwd,label,state,createdAt,updatedAt,endedAt,exitCode,signal,error,cursor,droppedBytes}=record;
  return {id,sessionId,kind:"background",owner:"builtin/process",command:terminalText(utf8Prefix(command,4096).text),...(Buffer.byteLength(command)>4096?{commandTruncated:true}:{}),cwd:terminalText(cwd),state,createdAt,updatedAt,cursor,droppedBytes,
    ...(label === undefined?{}:{label:terminalText(label)}),...(endedAt===undefined?{}:{endedAt}),...(exitCode===undefined?{}:{exitCode}),...(signal===undefined?{}:{signal}),...(error===undefined?{}:{error:terminalText(error)})};
}
export function commandText(row: CommandRecord): string {
  return `${row.label ?? row.command} — ${row.state}${row.exitCode == null ? "" : ` (exit ${row.exitCode})`} [${row.cwd}]`;
}
/** What a terminal shows for one line: a carriage return keeps only what follows it (a CRLF ending is not one). */
function shownLine(text: string): string | undefined {
  const body = text.endsWith("\r") ? text.slice(0, -1) : text;
  const shown = terminalText(body.slice(body.lastIndexOf("\r") + 1)).trimEnd();
  return shown.trim() ? shown : undefined;
}
/** The last non-empty lines of the retained output, newest last, each cut to its byte share. */
export function commandTail(chunks: readonly ProcessChunk[]): CommandTailLine[] {
  const lines: CommandTailLine[] = [];
  // Built from the end: the line being read, and the channel of its last non-empty piece.
  let line: { channel?: CommandTailLine["channel"]; text: string } = { text: "" };
  const close = () => {
    const shown = shownLine(line.text);
    if (shown !== undefined) lines.unshift({ channel: line.channel ?? "stdout", text: shown });
    line = { text: "" };
  };
  read: for (let index = chunks.length - 1; index >= 0; index--) {
    const chunk = chunks[index]!;
    const parts = chunk.text.split("\n");
    for (let part = parts.length - 1; part >= 0; part--) {
      line.text = parts[part]! + line.text;
      if (!line.channel && terminalText(parts[part]!).trim()) line.channel = chunk.channel;
      if (part > 0) { close(); if (lines.length >= TAIL_LINES) break read; }
    }
  }
  if (lines.length < TAIL_LINES) close();
  const tail: CommandTailLine[] = [];
  let total = 0;
  for (const entry of lines.slice(-TAIL_LINES).reverse()) {
    const text = utf8Prefix(entry.text, Math.min(TAIL_LINE_BYTES, TAIL_BYTES - total)).text;
    if (!text) break;
    total += Buffer.byteLength(text);
    tail.unshift({ channel: entry.channel, text });
  }
  return tail;
}
interface Entry {record:CommandRecord;chunks:ProcessChunk[];forgotten?:boolean;timer?:NodeJS.Timeout}
/** Independent durable host projection; never writes to a PanelHost or model transcript. */
export class Commands {
  private readonly active=new Map<string,Entry>();
  /** Each CLI task row as last written, by session and row id. */
  private readonly cliWritten=new Map<string,string>();
  constructor(private readonly options:{store?:SessionStore;hostToken:string;list:(sid:string)=>ProcessRecord[];output:(sid:string,id:string,cursor?:number,max?:number)=>ProcessOutput;publish?:(sid:string,items:CommandRecord[],omitted:number)=>void}) {}
  private stored(sessionId:string):Entry[] {
    return (this.options.store?.database.prepare("SELECT record_json,chunks_json FROM session_commands WHERE session_id = ? ORDER BY created_at DESC LIMIT 100").all(sessionId)??[])
      .map(row=>({record:JSON.parse(String(row.record_json)) as CommandRecord,chunks:JSON.parse(String(row.chunks_json)) as ProcessChunk[]}));
  }
  list(sessionId:string):CommandRecord[] { return this.listing(sessionId).items; }
  listing(sessionId:string):CommandListing {
    const entries=new Map(this.stored(sessionId).map(e=>[e.record.id,e]));
    for(const [id,e] of this.active) if(e.record.sessionId===sessionId) entries.set(id,e);
    const records=[...this.options.list(sessionId).map(presentProcess),...[...entries.values()].map(e=>structuredClone(e.record))];
    const sorted=records.sort((a,b)=>Number(LIVE_PROCESS_STATES.includes(b.state))-Number(LIVE_PROCESS_STATES.includes(a.state))||b.createdAt-a.createdAt||b.id.localeCompare(a.id));
    return {items:sorted.slice(0,COMMAND_ROWS),omitted:Math.max(0,sorted.length-COMMAND_ROWS)};
  }
  publish(sessionId:string):void {try {const {items,omitted}=this.listing(sessionId);this.options.publish?.(sessionId,items,omitted);}catch{/* observers do not own execution */}}
  private save(entry:Entry):void {
    if(entry.timer) clearTimeout(entry.timer);delete entry.timer;
    const r=entry.record;
    if(entry.forgotten||(this.options.store&&!this.options.store.getSession(r.sessionId)))return;
    r.updatedAt=Date.now();
    if(r.kind==="foreground"){const tail=commandTail(entry.chunks);if(tail.length)r.tail=tail;else delete r.tail;}
    this.options.store?.database.prepare("INSERT INTO session_commands(id,session_id,host_token,created_at,record_json,chunks_json) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json,chunks_json=excluded.chunks_json")
      .run(r.id,r.sessionId,this.options.hostToken,r.createdAt,JSON.stringify(r),JSON.stringify(entry.chunks));
    this.options.store?.database.prepare("DELETE FROM session_commands WHERE session_id=? AND id NOT IN (SELECT id FROM session_commands WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT 100)").run(r.sessionId,r.sessionId);
    this.publish(r.sessionId);
  }
  forSession(sessionId:string):CommandActivity {
    return {begin:(command,cwd,call)=>{
      const entry:Entry={record:{id:randomUUID(),sessionId,kind:"foreground",owner:call?.owner??"builtin/bash",command:terminalText(utf8Prefix(command,4096).text),...(Buffer.byteLength(command)>4096?{commandTruncated:true}:{}),cwd:terminalText(cwd),state:"running",createdAt:Date.now(),updatedAt:Date.now(),cursor:0,droppedBytes:0,
        ...(call?.label?{label:terminalText(utf8Prefix(call.label,800).text)}:{}),...(call?.toolCallId?{toolCallId:call.toolCallId}:{})},chunks:[]};
      this.active.set(entry.record.id,entry);this.save(entry);
      let finished=false;
      return {output:(channel,text)=>{
        if(finished||!text)return;
        const start=entry.record.cursor;const end=start+Buffer.byteLength(text); entry.record.cursor=end;
        entry.chunks.push({channel,start,end,text});
        while(entry.chunks.length&&(entry.chunks[0]!.end<=end-1024*1024||entry.chunks.length>4096))entry.chunks.shift();
        const first=entry.chunks[0];
        if(first&&first.start<end-1024*1024){const b=Buffer.from(first.text);let skip=end-1024*1024-first.start;while(skip<b.length&&(b[skip]!&0xc0)===0x80)skip++;first.text=b.subarray(skip).toString();first.start+=skip;}
        entry.record.droppedBytes=entry.chunks[0]?.start??end;
        if(!entry.timer)entry.timer=setTimeout(()=>{try{this.save(entry);}catch{entry.record.error="command output persistence unavailable";}},250);
      },finish:result=>{
        if(finished)return;finished=true;
        Object.assign(entry.record,{state:result.timedOut?"timed_out":result.code==="aborted"?"stopped":result.isError||result.exitCode!==0?"failed":"exited",endedAt:Date.now(),exitCode:result.exitCode??null,signal:result.signal??null,...(result.code?{error:result.code}:{}),
          ...(result.fullOutputPath?{fullOutputPath:result.fullOutputPath,...(result.fullOutputCapped?{fullOutputCapped:true}:{})}:{})});
        this.save(entry);
        const terminal=[...this.active.values()].filter(e=>e.record.sessionId===sessionId&&!LIVE_PROCESS_STATES.includes(e.record.state)).sort((a,b)=>b.record.createdAt-a.record.createdAt);
        for(const old of terminal.slice(100))this.active.delete(old.record.id);
      }};
    }};
  }
  /**
   * A backend CLI's background tasks: one row per task (`cli:<asyncTaskId>`), its state the CLI's; a `turn` task is the
   * CLI turn's operation, not a row. Their output stays in the CLI.
   */
  cli(sessionId:string,cwd:string,owner:CliCommandOwner):{upsert(task:CliTask):void} {
    return {upsert:task=>{
      if(task.type==="turn")return;
      const id=`cli:${task.id}`;
      const found=this.active.get(id);
      let entry=found?.record.sessionId===sessionId?found:undefined;
      const r=entry?.record??{cwd:terminalText(cwd),createdAt:task.startedAt,updatedAt:Date.now()};
      const state:CommandRecord["state"]=task.state==="paused"?"running":task.state==="completed"?"exited":task.state;
      const label=task.description&&task.description!==task.name?terminalText(utf8Prefix(task.description,800).text):undefined;
      const next:CommandRecord={id,sessionId,kind:"background",owner,command:terminalText(utf8Prefix(task.name,4096).text),...(Buffer.byteLength(task.name)>4096?{commandTruncated:true}:{}),
        cwd:r.cwd,state,createdAt:r.createdAt,updatedAt:r.updatedAt,cursor:0,droppedBytes:0,canStop:task.canStop,...(task.state==="paused"?{paused:true}:{}),
        ...(label===undefined?{}:{label}),...(task.endedAt===undefined?{}:{endedAt:task.endedAt}),...(task.exitCode===undefined?{}:{exitCode:task.exitCode}),
        ...(task.error===undefined?{}:{error:terminalText(utf8Prefix(task.error,800).text)})};
      // The CLI reports all its tasks on each change: a task written as it is now, even one no longer kept here, is not written again.
      const written=`${sessionId}\0${id}`;const shape=JSON.stringify({...next,updatedAt:0});
      if(this.cliWritten.get(written)===shape)return;
      if(entry)entry.record=next;else{entry={record:next,chunks:[]};this.active.set(id,entry);}
      this.save(entry);
      this.cliWritten.set(written,shape);
      const terminal=[...this.active.values()].filter(e=>e.record.sessionId===sessionId&&!LIVE_PROCESS_STATES.includes(e.record.state)).sort((a,b)=>b.record.createdAt-a.record.createdAt);
      for(const old of terminal.slice(100))this.active.delete(old.record.id);
    }};
  }
  output(sessionId:string,id:string,cursor=0,max=65536):ProcessOutput {
    if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(max)||max<1||max>65536)throw new ProcessError("invalid_arguments","invalid output cursor or page size");
    const candidate=this.active.get(id); const e=candidate?.record.sessionId===sessionId?candidate:this.stored(sessionId).find(e=>e.record.id===id);
    if(!e){const p=this.options.output(sessionId,id,cursor,max);return {...p,chunks:p.chunks.map(c=>({...c,text:terminalText(c.text)}))};}
    const earliestCursor=e.record.droppedBytes;let nextCursor=Math.min(e.record.cursor,Math.max(cursor,earliestCursor));let remaining=max;const chunks:ProcessChunk[]=[];
    for(const chunk of e.chunks){if(chunk.end<=nextCursor||!remaining)continue;const b=Buffer.from(chunk.text);let start=Math.max(0,nextCursor-chunk.start);while(start<b.length&&(b[start]!&0xc0)===0x80)start++;let end=Math.min(b.length,start+remaining);while(end>start&&end<b.length&&(b[end]!&0xc0)===0x80)end--;if(end===start){if(!chunks.length)throw new ProcessError("output_budget_too_small","output page cannot hold the next UTF-8 character");break;}chunks.push({channel:chunk.channel,start:chunk.start+start,end:chunk.start+end,text:terminalText(b.subarray(start,end).toString())});remaining-=end-start;nextCursor=chunk.start+end;if(end<b.length)break;}
    return {id,chunks,earliestCursor,nextCursor,cursor:e.record.cursor,droppedBytes:earliestCursor,truncated:cursor<earliestCursor||nextCursor<e.record.cursor};
  }
  forgetSession(sessionId:string):void {
    for(const key of this.cliWritten.keys())if(key.startsWith(`${sessionId}\0`))this.cliWritten.delete(key);
    for(const [id,entry] of this.active)if(entry.record.sessionId===sessionId){entry.forgotten=true;if(entry.timer)clearTimeout(entry.timer);this.active.delete(id);}
  }
  close():void {for(const e of this.active.values()){if(e.timer)clearTimeout(e.timer);delete e.timer;if(LIVE_PROCESS_STATES.includes(e.record.state)){e.record.state="lost";e.record.endedAt=Date.now();}this.save(e);}}
}
