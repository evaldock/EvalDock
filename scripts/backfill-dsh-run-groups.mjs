import {readFile,readdir,writeFile,mkdir} from "node:fs/promises";
import {homedir} from "node:os";
import path from "node:path";
import {reserveRunDisplay,evalSessionTitle} from "../dist/src/runtime/session-naming.js";
import {rpc} from "../dist/src/runtime/web-target.js";
const home=process.env.DSH_HOME??path.join(homedir(),".dsh");
const base=process.env.DSH_WEB_ENDPOINT??"http://127.0.0.1:3080";
const root=path.resolve("var/evaluation-results/agents");
const sessions=new Map((await rpc(base,"session.list",{})).items.map(s=>[s.sessionId,s]));
const runs=[];
for(const agent of await readdir(root)){
 const runRoot=path.join(root,agent,"runs");
 for(const runId of await readdir(runRoot).catch(()=>[])){
  const reports=[];
  const cases=path.join(runRoot,runId,"cases");
  for(const caseId of await readdir(cases).catch(()=>[])){
   try {const c=JSON.parse(await readFile(path.join(cases,caseId,"report.json"),"utf8"));if(c.execution?.dshSessionIds?.length)reports.push(c);}catch{}
  }
  if(reports.length)runs.push({agent,runId,reports,createdAt:reports.map(c=>c.execution?.startedAt??c.createdAt).sort()[0]});
 }
}
runs.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.runId.localeCompare(b.runId));
const changes=[],skipped=[];
for(const run of runs){
 const plugins=run.reports[0].inspection?.pluginCatalog?.filter(p=>p.bundlePatch).map(p=>p.packageName??p.id)??[];
 // Missing historical plugin evidence must not be substituted with today's profile.
 if(!plugins.length){skipped.push({run:run.runId,reason:"MISSING_PLUGIN_SNAPSHOT"});continue;}
 const display=await reserveRunDisplay(home,{agentId:run.agent,runId:run.runId,plugins,createdAt:run.createdAt});
 const reports=run.reports.sort((a,b)=>Number(a.scope?.runId?.match(/\.c(\d+)$/)?.[1]??1)-Number(b.scope?.runId?.match(/\.c(\d+)$/)?.[1]??1));
 for(const [index,c] of reports.entries()){
  const ordinal=Number(c.scope?.runId?.match(/\.c(\d+)$/)?.[1]??index+1);
  const caseName=c.case?.question?.id??c.case?.caseId??c.scope.caseId;
  for(const sessionId of c.execution.dshSessionIds){
   const s=sessions.get(sessionId);if(!s)continue;
   const old=s.projections?.values?.title??"";
   const oldTitle=typeof old==="string"?old:old.title??"";
   if(!oldTitle.startsWith("EvalDock ")){skipped.push({sessionId,reason:"CUSTOM_TITLE"});continue;}
   const title=evalSessionTitle(display,ordinal,caseName);
   if(title===oldTitle)continue;
   changes.push({sessionId,cwd:s.cwd,oldTitle,title,agentId:run.agent,runId:run.runId});
  }
 }
}
const archive=path.join(home,"evaldock-display","migrations");await mkdir(archive,{recursive:true,mode:0o700});
const file=path.join(archive,new Date().toISOString().replace(/[:.]/g,"-")+".json");
await writeFile(file,JSON.stringify({changes,skipped},null,2),{mode:0o600});
if(process.argv.includes("--apply"))for(const c of changes)await rpc(base,"session.rename",{sessionId:c.sessionId,title:c.title});
console.log(JSON.stringify({apply:process.argv.includes("--apply"),sessions:changes.length,runs:new Set(changes.map(c=>c.agentId+"/"+c.runId)).size,skipped:skipped.length,backup:file,preview:changes.slice(0,3).map(c=>c.title)},null,2));
