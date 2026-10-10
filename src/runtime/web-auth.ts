/** Local DSH launch-token exchange. Credentials stay in memory and never enter evidence. */
import {open} from "node:fs/promises";
const cookies=new Map<string,string>();
export function localWebOrigin(base:string):string {
 const u=new URL(base);
 if(u.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(u.hostname)||u.username||u.password||u.pathname!=="/"||u.search||u.hash)throw Error("DSH_WEB_AUTH_ORIGIN_INVALID");
 return u.origin;
}
export function webAuthHeaders(base:string):Record<string,string>{const cookie=cookies.get(localWebOrigin(base));return cookie?{cookie}:{};}
export async function webFetch(base:string,route:string,options:RequestInit={}):Promise<Response>{
 const origin=localWebOrigin(base);
 if(!route.startsWith("/")||route.startsWith("//")||new URL(route,origin).origin!==origin)throw Error("DSH_WEB_AUTH_ROUTE_INVALID");
 const headers=new Headers(options.headers);for(const [k,v] of Object.entries(webAuthHeaders(origin)))headers.set(k,v);
 return fetch(origin+route,{...options,headers,redirect:"manual"});
}
export async function authenticateDshWeb(base:string,launchLog:string):Promise<void>{
 const origin=localWebOrigin(base);
 const probe=await webFetch(origin,"/",{signal:AbortSignal.timeout(5000)});
 await probe.body?.cancel();
 if(probe.status!==401){if(probe.status>=400)throw Error("DSH_WEB_HTTP_"+probe.status);return;}
 cookies.delete(origin);
 let text:string;
 try{
  const file=await open(launchLog,"r");
  try{const stat=await file.stat(),length=Math.min(stat.size,1024*1024),buffer=Buffer.alloc(length);const read=await file.read(buffer,0,length,stat.size-length);text=buffer.subarray(0,read.bytesRead).toString("utf8");}finally{await file.close();}
 }catch{throw Error("DSH_WEB_AUTH_LAUNCH_URL_REQUIRED");}
 const urls=[...text.matchAll(/http:\/\/[^\s\x1b]+/g)].map(m=>m[0]).filter(value=>{
  try{const u=new URL(value);return u.origin===origin&&u.pathname==="/"&&!u.username&&!u.password&&!u.hash&&u.searchParams.getAll("token").length===1;}catch{return false;}
 });
 const url=urls.at(-1);if(!url)throw Error("DSH_WEB_AUTH_LAUNCH_URL_REQUIRED");
 let response:Response;
 try{response=await fetch(url,{redirect:"manual",signal:AbortSignal.timeout(5000)});}catch{throw Error("DSH_WEB_AUTH_EXCHANGE_FAILED");}
 await response.body?.cancel();
 const cookie=response.headers.getSetCookie().map(v=>v.split(";",1)[0]!).find(v=>/^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+$/.test(v));
 if(response.status!==303||response.headers.get("location")!=="/"||!cookie)throw Error("DSH_WEB_AUTH_EXCHANGE_FAILED");
 cookies.set(origin,cookie);
 const verified=await webFetch(origin,"/",{signal:AbortSignal.timeout(5000)});await verified.body?.cancel();
 if(!verified.ok){cookies.delete(origin);throw Error("DSH_WEB_AUTH_EXCHANGE_FAILED");}
}
