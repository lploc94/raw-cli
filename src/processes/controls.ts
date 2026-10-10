import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import type { SessionStore } from "../sessions/store.js";
import { loadToolPlugins } from "../tools/plugins/loader.js";
import { loadSelectedHooks } from "../hooks/loader.js";
import { HookDispatcher, type HookReceipt } from "../hooks/dispatcher.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/primitives.js";
import type { ToolResult } from "../tools/types.js";
import { errorResult } from "../tools/results.js";
import { approvalTimeoutMs } from "../sessions/operation-types.js";
import type { ProcessSupervisor } from "./supervisor.js";
import { ProcessError } from "./contract.js";
export interface ProcessControl {
  id:string;sessionId:string;processId:string;clientRequestId:string;state:"running"|"completed"|"failed"|"interrupted";
  action?: "stop" | "output" | "status";
  arguments: Record<string,unknown>;
  createdAt:number;updatedAt:number;result?:ToolResult;hooks?:HookReceipt[];
}
/** Durable service events are independent of session model history and writer leases. */
export class ProcessControls {
  private readonly active=new Map<string,{controller:AbortController;done:Promise<ToolResult>}>();
  constructor(private readonly options:{store:SessionStore;processes:ProcessSupervisor;configPath:string;env:NodeJS.ProcessEnv;
    approve:(control:ProcessControl,timeout:number)=>NonNullable<ToolContext["approve"]>;publish?:(control:ProcessControl)=>void}) {
    for(const row of options.store.database.prepare("SELECT c.record_json FROM session_process_controls c LEFT JOIN process_hosts h ON h.token=c.host_token WHERE c.state='running' AND (h.token IS NULL OR h.alive=0)").all()){
      const record=JSON.parse(String(row.record_json)) as ProcessControl;record.state="interrupted";record.updatedAt=Date.now();record.result=errorResult("interrupted","process control host was lost");this.save(record);
    }
  }
  private save(record:ProcessControl):void {
    this.options.store.database.prepare("UPDATE session_process_controls SET state=?,record_json=? WHERE id=?").run(record.state,JSON.stringify(record),record.id);
    try { this.options.publish?.(structuredClone(record)); } catch { /* observers never own dispatch */ }
  }
  get(sessionId:string,processId:string,id:string):ProcessControl|undefined {
    const row=this.options.store.database.prepare("SELECT record_json FROM session_process_controls WHERE session_id=? AND process_id=? AND id=?").get(sessionId,processId,id);
    return row?JSON.parse(String(row.record_json)) as ProcessControl:undefined;
  }
  async read(sessionId:string,processId:string,arguments_:Record<string,unknown>):Promise<ToolResult> {
    const receipt=this.submit(sessionId,processId,randomUUID(),arguments_);
    return this.active.get(receipt.id)!.done;
  }
  submit(sessionId:string,processId:string,clientRequestId:string,arguments_:Record<string,unknown>={action:"stop",id:processId}):ProcessControl {
    arguments_=structuredClone(arguments_);
    const existing=this.options.store.database.prepare("SELECT record_json FROM session_process_controls WHERE session_id=? AND client_request_id=?").get(sessionId,clientRequestId);
    if(existing){const prior=JSON.parse(String(existing.record_json)) as ProcessControl;if(prior.processId!==processId)throw new ProcessError("control_conflict","clientRequestId already belongs to another process control");return prior;}
    if(this.active.size>=32 || Number(this.options.store.database.prepare("SELECT COUNT(*) n FROM session_process_controls WHERE session_id=? AND state='running'").get(sessionId)!.n)>=8)
      throw new ProcessError("control_limit","too many pending process controls");
    this.options.processes.forSession(sessionId).status(processId);
    const session=this.options.store.getSession(sessionId);
    if(!session)throw new ProcessError("session_not_found","session not found");
    const record:ProcessControl={id:randomUUID(),sessionId,processId,clientRequestId,arguments:arguments_,action:arguments_.action as NonNullable<ProcessControl["action"]>,state:"running",createdAt:Date.now(),updatedAt:Date.now()};
    this.options.store.database.prepare("INSERT INTO session_process_controls(id,session_id,client_request_id,process_id,host_token,created_at,state,record_json) VALUES(?,?,?,?,?,?,?,?)")
      .run(record.id,sessionId,clientRequestId,processId,this.options.processes.hostToken,record.createdAt,record.state,JSON.stringify(record));
    // Bound completed audit retention; pending receipts are never pruned.
    this.options.store.database.prepare("DELETE FROM session_process_controls WHERE session_id=? AND state<>'running' AND id NOT IN (SELECT id FROM session_process_controls WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT 200)").run(sessionId,sessionId);
    const controller=new AbortController();
    const done=Promise.resolve().then(()=>this.execute(record,controller.signal,arguments_)).catch(error=>{
      record.state="failed";record.updatedAt=Date.now();record.result=errorResult("control_error",error instanceof Error?error.message:String(error));this.save(record);return record.result;
    }).finally(()=>this.active.delete(record.id));
    this.active.set(record.id,{controller,done});return structuredClone(record);
  }
  private async execute(record:ProcessControl,signal:AbortSignal,arguments_:Record<string,unknown>):Promise<ToolResult> {
    const session=this.options.store.getSession(record.sessionId)!;const savedAgent=session.agentName;
    if(!savedAgent){record.result=errorResult("tool_not_exposed","session has no saved agent");}
    else {
      const runtime=await loadConfig({configPath:this.options.configPath,cwd:session.cwd,flags:{agent:savedAgent},env:this.options.env,requireModel:false});
      if(!runtime.toolIds.includes("builtin/process"))record.result=errorResult("tool_not_exposed","builtin/process is not selected by the saved agent");
      else {
        const [plugin]=await loadToolPlugins({selectedIds:["builtin/process"],configPath:runtime.configPath,cwd:session.cwd,globalConfigRoot:runtime.globalConfigRoot});
        const selectedHooks=await loadSelectedHooks({selectedIds:runtime.hookIds,configPath:runtime.configPath,cwd:session.cwd,globalConfigRoot:runtime.globalConfigRoot,packageHooks:runtime.packageHooks,env:this.options.env});
        const registry=new ToolRegistry(runtime.toolRules);
        const fingerprint=(config:typeof runtime)=>JSON.stringify([config.toolIds,config.toolRules,config.hookIds,config.autoApprove]);
        registry.register({...plugin!.registration,handler:async(args,context)=>{
          if(this.options.store.getSession(record.sessionId)?.agentName!==savedAgent)return errorResult("stale_agent","session agent changed before process control execution");
          const current=await loadConfig({configPath:this.options.configPath,cwd:session.cwd,flags:{agent:savedAgent},env:this.options.env,requireModel:false});
          if(fingerprint(current)!==fingerprint(runtime))return errorResult("control_config_changed","tool selection or policy changed while the control was waiting; retry the control");
          if(context.signal?.aborted)return errorResult("aborted","process control interrupted");
          if(this.options.store.getSession(record.sessionId)?.agentName!==savedAgent)return errorResult("stale_agent","session agent changed before process control execution");
          return plugin!.registration.handler(args,context);
        }});
        const hooks=new HookDispatcher(selectedHooks,this.options.env);hooks.validateTools(registry,[plugin!.registration.name]);
        // Loading may await I/O; a changed saved agent never inherits this captured authority.
        if(this.options.store.getSession(record.sessionId)?.agentName!==savedAgent)record.result=errorResult("stale_agent","session agent changed before control dispatch");
        else record.result=await registry.dispatch(plugin!.registration.name,arguments_,{cwd:session.cwd,maxOutputBytes:Math.min(runtime.maxOutputBytes,65536),autoApprove:runtime.autoApprove,whitelist:[plugin!.registration.name],signal,toolCallId:record.id,
          approve:this.options.approve(record,approvalTimeoutMs(this.options.env)),processes:this.options.processes.forSession(record.sessionId),
          onHook:(event,identity,name,args,result,effects)=>hooks.run(event,{cwd:session.cwd,agent_id:savedAgent,session_id:record.sessionId,turn_id:record.id,tool:{identity,name,source:"user_action",arguments:args,...(result?{result}:{}),...(effects?{effects}:{})}},
            {...(event==="PreToolUse"?{signal}:signal.aborted?{deadline:Date.now()+2000}:{}),onReceipt:receipt=>{record.hooks=[...(record.hooks??[]),receipt].slice(-64);this.save(record);}})});
      }
    }
    record.state=signal.aborted?"interrupted":record.result?.isError?"failed":"completed";record.updatedAt=Date.now();
    const result=record.result!;
    // Output bytes already have their own bounded process log; never duplicate them in audit history.
    if(record.action==="output"&&!result.isError) record.result={isError:false,content:[]};
    this.save(record);return result;
  }
  async close():Promise<void>{for(const entry of this.active.values())entry.controller.abort();await Promise.allSettled([...this.active.values()].map(e=>e.done));}
}
