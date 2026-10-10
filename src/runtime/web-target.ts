import {dshRpc,detectWebProtocol,setSessionPermission} from "./dsh-web-protocol.js";
import {authenticateDshWeb} from "./web-auth.js";
import {latestCompletedTurn,historySequence,cancelSessionAndWait} from "./session-lifecycle.js";
import {reserveRunDisplay,evalSessionTitle} from "./session-naming.js";
/** Execute a real Case through the existing DSH Web service. No substitute agent or profile. */
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {readFile,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import type {TargetDescriptor,JsonObject} from "../core/models.js";
import type {TargetExecutionRequest,TargetExecutionResult} from "./target.js";
import { startAutoInteraction } from "./auto-interaction.js";
const exec=promisify(execFile);
type Obj=Record<string,any>;
function endpoint(descriptor:TargetDescriptor):string {
  const u=new URL(descriptor.webEndpoint!);
  if(u.protocol!=="http:" || !["127.0.0.1","localhost","[::1]"].includes(u.hostname) || u.username || u.password || u.pathname!=="/" || u.search || u.hash) throw new Error("DSH Web endpoint must be a local HTTP origin");
  return u.origin;
}
export const rpc=dshRpc;
export async function liveIdentity(descriptor:TargetDescriptor):Promise<{pid:number;base:string}> {
  const base=endpoint(descriptor),port=new URL(base).port||"80";
  const {stdout}=await exec("/usr/sbin/lsof",["-nP","-t","-iTCP:"+port,"-sTCP:LISTEN"]);
  const pids=[...new Set(stdout.trim().split(/\s+/).filter(Boolean))];
  if(pids.length!==1)throw new Error("DSH_WEB_LISTENER_AMBIGUOUS");
  const pid=Number(pids[0]);
  const command=(await exec("/bin/ps",["-p",String(pid),"-o","command="])).stdout.trim();
  const words=command.split(/\s+/);
  const profileIndex=words.indexOf("--profile");
  const installed=await realpath(path.resolve(descriptor.sourceRoot,descriptor.dshExecutable));
  let scriptIndex=1;
  while(words[scriptIndex]?.startsWith("--env-file="))scriptIndex++;
  const actual=await realpath(words[scriptIndex]??"").catch(()=>"");
  if(actual!==installed || words[profileIndex+1]!==descriptor.profile)throw new Error("DSH_WEB_PROCESS_TARGET_MISMATCH");
  // Inspect only the effective DSH_HOME name; never return or log the process environment.
  const environment=(await exec("/bin/ps",["eww","-p",String(pid),"-o","command="])).stdout;
  const home=environment.match(/(?:^|\s)DSH_HOME=([^\s]+)/)?.[1];
  if(home && await realpath(home)!==await realpath(descriptor.dshHome))throw new Error("DSH_WEB_HOME_MISMATCH");
  await authenticateDshWeb(base,path.join(descriptor.dshHome,"evaldock-control",descriptor.profile,"service.log"));
  await detectWebProtocol(base,undefined,true);
  const host=await rpc(base,"host.describe",{});
  const effectiveHome=home??path.join(host.home,".dsh");
  if(await realpath(effectiveHome)!==await realpath(descriptor.dshHome))throw new Error("DSH_WEB_HOME_MISMATCH");
  return {pid,base};
}
export async function inspectWebTarget(descriptor:TargetDescriptor):Promise<JsonObject> {
  const {pid,base}=await liveIdentity(descriptor);
  const [settings,profile,pkg]=await Promise.all([
    rpc(base,"settings.describe",{}),
    readFile(path.join(descriptor.dshHome,"profiles",descriptor.profile,"package.json"),"utf8").then(JSON.parse),
    readFile(path.join(descriptor.sourceRoot,"package.json"),"utf8").then(JSON.parse),
  ]);
  const permission=settings.namespaces.find((n:Obj)=>n.ns==="permission")?.value?.defaultPreset;
  const model=settings.namespaces.find((n:Obj)=>n.ns==="agent-default-model")?.value;
  return {dshVersion:pkg.version,permissionPreset:permission??"UNKNOWN",
    sandboxMode:permission==="workspace-write"?"workspace-write":["full-access","danger-full-access"].includes(permission)?"danger-full-access":"UNKNOWN",
    profile:{plugins:profile.dsh.profile.bundles.map((name:string)=>({name}))},
    web:{endpoint:base,pid,profile:descriptor.profile,dshHome:descriptor.dshHome,model},
    probe:{configured:false,schema:"dsh-eval.probe/v1",order:"UNKNOWN",captureDispatch:false,captureLogs:false,
      oneShot:true,sourceRunIdEcho:true,contentModes:["STRUCTURED"]},
    limitations:[{code:"SESSION_ARCHIVE_CAPTURE",status:"DECLARED",
      messageRedacted:"Agent evidence is the real DSH persisted session archive. Native Probe framework dispatch and private runtime snapshots are not collected."}]};
}
export async function executeWebTarget(request:TargetExecutionRequest,descriptor:TargetDescriptor):Promise<TargetExecutionResult> {
  const startedAt=new Date().toISOString();
  if(String(descriptor.targetId).startsWith("vm.dsh.")){
    const {dshConfiguration}=await import("./dsh-control.js");
    if((await dshConfiguration(descriptor)).agentId!==descriptor.targetId)throw new Error("DSH_AGENT_CONFIGURATION_CHANGED");
  }
  const {pid,base}=await liveIdentity(descriptor);
  const result=(terminationKind:TargetExecutionResult["terminationKind"],stdout="",errorMessage?:string):TargetExecutionResult=>{
    const bytes=Buffer.from(stdout);
    return {terminationKind,pid,startedAt,endedAt:new Date().toISOString(),
      exitCode:terminationKind==="EXITED"?0:1,stdout:bytes.subarray(0,request.maxOutputBytes),stderr:Buffer.alloc(0),
      stdoutTruncated:bytes.length>request.maxOutputBytes,stderrTruncated:false,...(errorMessage?{errorMessage}:{})};
  };
  if(request.signal?.aborted)return result("CANCELLED");
  const content:Obj[]=[{type:"text",text:request.task}];
  for(const input of request.inputs??[]) {
    if(input.delivery!=="chat-attachment")continue;
    if(!["image/png","image/jpeg","image/webp","image/gif"].includes(input.mediaType))throw new Error("DSH_ATTACHMENT_MEDIA_UNSUPPORTED: "+input.mediaType);
    const absolute=await realpath(path.join(request.cwd,input.destination));
    const root=await realpath(path.join(request.cwd,"input"));
    if(!absolute.startsWith(root+path.sep))throw new Error("DSH_ATTACHMENT_PATH_ESCAPE");
    const bytes=await readFile(absolute);
    if(createHash("sha256").update(bytes).digest("hex")!==input.sha256)throw new Error("DSH_ATTACHMENT_DIGEST_MISMATCH");
    content.push({type:"image",mediaType:input.mediaType,data:bytes.toString("base64"),name:path.basename(input.destination)});
  }
  const {dshConfiguration}=await import("./dsh-control.js");
  const configuration=await dshConfiguration(descriptor);
  const displayCase=request.displayCase ?? {runId:request.sourceRunId.replace(/\.c\d+\.source$|\.source$/,""),ordinal:Number(request.sourceRunId.match(/\.c(\d+)\.source$/)?.[1]??1),name:request.sourceRunId};
  const runDisplay=await reserveRunDisplay(descriptor.dshHome,{agentId:String(descriptor.targetId),runId:displayCase.runId,plugins:configuration.plugins.map(p=>p.name)});
  const title=evalSessionTitle(runDisplay,displayCase.ordinal,displayCase.name);
  const {sessionId}=await rpc(base,"session.create",{cwd:request.cwd},request.signal);
  const receiptPath=path.join(request.runtimeDshHomePath,"web-session.json");
  await writeFile(receiptPath,JSON.stringify({endpoint:base,pid,sessionId,cwd:request.cwd,profile:descriptor.profile,sourceRunId:request.sourceRunId,display:{...runDisplay,caseOrdinal:displayCase.ordinal,caseName:displayCase.name},captureSource:"DSH_SESSION_ARCHIVE",interactionPolicy:{permissionPreset:"danger-full-access",approval:"AUTOMATIC_ALLOW",questions:"RECOMMENDED_OR_AGENT_DECIDES"}},null,2)+"\n",{mode:0o600});
  await rpc(base,"session.rename",{sessionId,title});
  await request.onStarted?.(pid);
  process.stderr.write("[evaldock:web] session created "+sessionId+"; existing PID "+pid+"\n");
  const deadline=Date.now()+request.deadlineMs;
  let previousProgress=0;
  const automation = startAutoInteraction({
    base,sessionId,
    signal:AbortSignal.any([...(request.signal?[request.signal]:[]),AbortSignal.timeout(request.deadlineMs)]),
    onDecision:record=>process.stderr.write("[evaldock:web] automatic "+String(record.type)+" answered for "+sessionId+"\n"),
    onError:error=>process.stderr.write("[evaldock:web] interaction reconnect: "+String(error instanceof Error?error.message:error)+"\n"),
  });
  try {
    await automation.ready;
    const initialHistory=await rpc(base,"session.history",{sessionId,maxMessages:1},request.signal);
    // Native profiles can already inherit the required preset; do not submit a redundant
    // slash command as model input on hosts that expose commands through a separate carrier.
    if(initialHistory.projections?.values?.permissions?.currentValue!=="danger-full-access"){
      await setSessionPermission(base,sessionId,request.signal);
    }
    const afterSeq=historySequence(await rpc(base,"session.history",{sessionId,maxMessages:1},request.signal));
    await rpc(base,"session.prompt",{sessionId,mode:"queue",content},request.signal);
    process.stderr.write("[evaldock:web] Case prompt accepted by real DSH\n");
    while(Date.now()<deadline && !request.signal?.aborted) {
      const history=await rpc(base,"session.history",{sessionId,maxMessages:200},request.signal);
      const events=(history.events??[]).map((x:Obj)=>x.event);
      const end=latestCompletedTurn(history,afterSeq);
      const idle=end && !(await rpc(base,"session.list",{},request.signal)).items.some((s:Obj)=>s.sessionId===sessionId && s.running);
      if(end && idle) {
        const final=[...events].reverse().find((e:Obj)=>e.type==="assistant/message");
        const text=(final?.data?.message?.content??[]).filter((p:Obj)=>p.type==="text").map((p:Obj)=>p.text).join("\n");
        const reason=end.data?.reason?.kind;
        await writeFile(receiptPath,JSON.stringify({endpoint:base,pid,sessionId,cwd:request.cwd,profile:descriptor.profile,sourceRunId:request.sourceRunId,display:{...runDisplay,caseOrdinal:displayCase.ordinal,caseName:displayCase.name},captureSource:"DSH_SESSION_ARCHIVE",interactionPolicy:{permissionPreset:"danger-full-access",approval:"AUTOMATIC_ALLOW",questions:"RECOMMENDED_OR_AGENT_DECIDES"},endReason:reason,endedAt:new Date().toISOString()},null,2)+"\n",{mode:0o600});
        process.stderr.write("[evaldock:web] Case turn ended: "+String(reason)+"\n");
        await new Promise(r=>setTimeout(r,1000));
        return result(reason==="completed"?"EXITED":"TARGET_FAILED",text,end.data?.reason?.error?.code==="TRANSPORT"?"DSH_MODEL_TRANSPORT_ERROR":undefined);
      }
      if(Date.now()-previousProgress>15000) {
        const calls=events.filter((e:Obj)=>e.type==="tool/call");
        process.stderr.write("[evaldock:web] running; visible tool calls="+calls.length+"; last="+String(calls.at(-1)?.data?.name??"none")+"\n");
        previousProgress=Date.now();
      }
      await new Promise(r=>setTimeout(r,1500));
    }
    await cancelSessionAndWait((method,payload)=>rpc(base,method,payload),sessionId);
    return result(request.signal?.aborted?"CANCELLED":"TIMED_OUT");
  } catch(error) {
    process.stderr.write("[evaldock:web] execution error: "+(error instanceof Error?error.message:"DSH_WEB_ERROR")+"\n");
    try{await cancelSessionAndWait((method,payload)=>rpc(base,method,payload),sessionId);}
    catch(cancelError){return result("HARNESS_ERROR","",String(cancelError));}
    return result(request.signal?.aborted?"CANCELLED":"HARNESS_ERROR","",error instanceof Error?error.message:"DSH_WEB_ERROR");
  } finally { await automation.stop(); }
}
