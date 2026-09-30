import {setTimeout as delay} from "node:timers/promises";
type Rpc=(method:string,payload:Record<string,unknown>)=>Promise<any>;
export function latestCompletedTurn(history:any,afterSeq:number):any|undefined {
  return [...(history.events??[])].map((x:any)=>x.event??x).reverse()
    .find((e:any)=>e.type==="turn/end" && typeof e.seq==="number" && e.seq>afterSeq);
}
export function historySequence(history:any):number {
  return Math.max(0,Number(history.projections?.asOfSeq)||0,...(history.events??[]).map((x:any)=>Number((x.event??x).seq)||0));
}
export async function cancelSessionAndWait(rpc:Rpc,sessionId:string,options:{timeoutMs?:number;pollMs?:number}={}):Promise<void>{
  const deadline=Date.now()+(options.timeoutMs??20000);
  await rpc("session.cancel",{sessionId});
  do{
    const sessions=await rpc("session.list",{});
    if(!Array.isArray(sessions.items))throw new Error("DSH_SESSION_STATE_UNKNOWN");
    if(!sessions.items.some((s:any)=>s.sessionId===sessionId && s.running))return;
    await delay(options.pollMs??100);
  }while(Date.now()<deadline);
  throw new Error("DSH_SESSION_CANCEL_UNCONFIRMED");
}
