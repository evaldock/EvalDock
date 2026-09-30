/** Human display metadata only. Original Agent/Run/Case/session IDs remain authoritative. */
import {createHash,randomUUID} from "node:crypto";
import {mkdir,readFile,writeFile,link,unlink} from "node:fs/promises";
import path from "node:path";
const base = new Set(["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]);
const clean = (s:string) => s.replace(/[\r\n]/g," ").replace(/ · /g," / ").trim();
export function agentDisplayName(names:readonly string[]):string {
  return ["DSH",...[...new Set(names)].filter(n=>!base.has(n)).sort().map(clean)].join(" + ");
}
export function caseDisplayName(id:string):string {
  const normalized=id.replace(/^(scenario\.|question\.)/,"").replace(/\/v\d+$/,"");
  return clean(normalized.includes(".") ? normalized.slice(normalized.lastIndexOf(".")+1) : normalized.replace(/^harbor-/,""));
}
export interface RunDisplay {version:1;agentId:string;runId:string;agentName:string;runName:string;createdAt:string}
export async function reserveRunDisplay(home:string,input:{agentId:string;runId:string;plugins:readonly string[];createdAt?:string}):Promise<RunDisplay> {
  const root=path.join(home,"evaldock-display","runs");
  await mkdir(root,{recursive:true,mode:0o700});
  const key=createHash("sha256").update(JSON.stringify([input.agentId,input.runId])).digest("hex");
  const file=path.join(root,key+".json");
  const existing=()=>readFile(file,"utf8").then(s=>JSON.parse(s) as RunDisplay);
  try{return await existing();}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  const createdAt=input.createdAt??new Date().toISOString();
  const day=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(createdAt)).replace(/-/g,"");
  const temp=path.join(root,"."+randomUUID()+".tmp");
  for(let seq=1;seq<100000;seq++){
    const runName=day+"-"+String(seq).padStart(2,"0");
    const value:RunDisplay={version:1,agentId:input.agentId,runId:input.runId,agentName:agentDisplayName(input.plugins),runName,createdAt};
    await writeFile(temp,JSON.stringify(value,null,2)+"\n",{mode:0o600});
    const claim=path.join(root,runName+".json");
    try{await link(temp,claim);}catch(e){
      await unlink(temp);
      if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
      // Another Case of this same Run can finish publishing its first reservation.
      const reserved=JSON.parse(await readFile(claim,"utf8")) as RunDisplay;
      if(reserved.agentId!==input.agentId||reserved.runId!==input.runId)continue;
      try{await link(claim,file);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
      return existing();
    }
    await unlink(temp);
    try{await link(claim,file);return value;}
    catch(e){
      if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
      const winner=await existing();
      if(winner.runName!==runName)await unlink(claim);
      return winner;
    }
  }
  throw new Error("EVALDOCK_RUN_DISPLAY_EXHAUSTED");
}
export function evalSessionTitle(run:RunDisplay,ordinal:number,caseName:string):string {
  if(!Number.isSafeInteger(ordinal)||ordinal<1)throw new Error("Invalid Case ordinal");
  return ["EvalDock",run.agentName,run.runName,"C"+String(ordinal).padStart(2,"0"),caseDisplayName(caseName)].join(" · ");
}
